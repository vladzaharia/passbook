import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  type WalletProviderScope,
  WalletProviderScopeSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { UnavailableError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  corrupt,
  decryptAccount,
  type KeyOnlyAccount,
  openAccount,
  type StoredCredentials,
  snapshotWalletCredentialContext,
} from './account-credential-material.ts';
import {
  applyEnrolmentSource,
  enrolmentOf,
  historicalSources,
} from './account-credential-source.ts';
import { providerIdentityHash } from './projection-contract.ts';
import { findSamsungTombstoneCredential } from './repo-accounts.ts';
import { findSamsungIssuedRefCredential } from './repo-accounts-issued.ts';
import { DEFAULT_CARD_TYPE, samsungCardId } from './samsung-cards.ts';

/** Public verification material only, usable solely for a retired Samsung reference callback. */
export interface SamsungVerificationMaterial {
  accountId: string;
  accountRevision: number;
  partnerId: string;
  certificateId: string;
  cardId: string;
  samsungCertificatePem: string;
}

/** `later`: the same credential's later versions, tried in order after a certificate rotation. */
export interface SamsungTombstoneVerification extends SamsungVerificationMaterial {
  later: SamsungVerificationMaterial[];
}

type Samsung = Extract<StoredCredentials, { provider: 'samsung' }>;

const material = (
  accountId: string,
  accountRevision: number,
  stored: Samsung,
  cardType: string | null,
): SamsungVerificationMaterial => ({
  accountId,
  accountRevision,
  partnerId: stored.credentials.partnerId,
  certificateId: stored.credentials.certificateId,
  cardId: samsungCardId(stored.credentials, cardType ?? DEFAULT_CARD_TYPE),
  samsungCertificatePem: stored.credentials.samsungCertificatePem,
});

const isSamsung = (stored: StoredCredentials): stored is Samsung => stored.provider === 'samsung';

/** The legacy envelope for an unpinned row, else the pinned version and the later versions of its credential. */
async function candidates(
  ctx: ServiceContext,
  row: Parameters<typeof enrolmentOf>[0] & { pin_version_id: string | null },
  stored: StoredCredentials | KeyOnlyAccount,
): Promise<Samsung[]> {
  if (!row.pin_version_id && stored.credentials === null) throw corrupt();
  const all = row.pin_version_id
    ? await historicalSources(ctx, enrolmentOf(row), stored, row.pin_version_id)
    : [stored as StoredCredentials];
  if (!all.every(isSamsung)) throw corrupt();
  return all;
}

/** Resolve one immutable provider-verified historical pin only through its exact tombstone. */
export async function readSamsungTombstoneVerification(
  ctx: ServiceContext,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    refHash: string;
  },
): Promise<SamsungTombstoneVerification | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const pinned = { ...input };
  if (
    !WalletProviderScopeSchema.safeParse({
      orgId: pinned.orgId,
      mode: pinned.mode,
      provider: 'samsung',
    }).success ||
    !IdSchema.safeParse(pinned.accountId).success ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    !/^[0-9a-f]{64}$/.test(pinned.refHash)
  )
    throw new ValidationError();
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const row = await findSamsungTombstoneCredential(ctx.env.DB, pinned);
  const stored = row ? await openAccount(ctx, row) : null;
  const found = row && stored ? await candidates(ctx, row, stored) : [];
  const [first, ...later] = found;
  if (!row || !first) return null;
  // The tombstone's identity binds the pinned version; a later version of another card is not its successor.
  if (
    (await providerIdentityHash(first, row.card_type ?? undefined)) !== row.provider_identity_hash
  )
    throw corrupt();
  const successors: SamsungVerificationMaterial[] = [];
  for (const next of later)
    if (
      (await providerIdentityHash(next, row.card_type ?? undefined)) === row.provider_identity_hash
    )
      successors.push(material(row.id, row.revision, next, row.card_type));
  return { ...material(row.id, row.revision, first, row.card_type), later: successors };
}

export interface SamsungIssuedVerification extends SamsungVerificationMaterial {
  /**
   * True only when this credential is the account's current one (or equals it in partner,
   * certificate id and Samsung certificate) and the account is not revoked. An older credential may
   * authenticate a callback so it is answered; it may not write state.
   */
  writable: boolean;
  later: (SamsungVerificationMaterial & { writable: boolean })[];
}

const sameCertificate = (a: Samsung, b: Samsung) =>
  a.credentials.partnerId === b.credentials.partnerId &&
  a.credentials.certificateId === b.credentials.certificateId &&
  a.credentials.samsungCertificatePem === b.credentials.samsungCertificatePem;

/** Public verification material for a callback on an issued ref, from a revision it has operated under. */
export async function readSamsungIssuedRefVerification(
  ctx: ServiceContext,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    refHash: string;
  },
): Promise<SamsungIssuedVerification | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const pinned = { ...input };
  if (
    !WalletProviderScopeSchema.safeParse({
      orgId: pinned.orgId,
      mode: pinned.mode,
      provider: 'samsung',
    }).success ||
    !IdSchema.safeParse(pinned.accountId).success ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    !/^[0-9a-f]{64}$/.test(pinned.refHash)
  )
    throw new ValidationError();
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const row = await findSamsungIssuedRefCredential(ctx.env.DB, { ...pinned, operated: true });
  const stored = row ? await openAccount(ctx, row) : null;
  if (!row || !stored) return null;
  if (stored.provider !== 'samsung') throw corrupt();
  const found = await candidates(ctx, row, stored);
  let writable: (candidate: Samsung) => Promise<boolean> = async () => false;
  if (row.account_revoked_at === null) {
    if (row.pin_version_id) {
      // A pinned credential may write only while it equals the source the enrolment has now.
      const current = await applyEnrolmentSource(ctx, enrolmentOf(row), stored, {
        current: true,
        activeOnly: true,
      }).catch((error: unknown) => {
        if (!(error instanceof UnavailableError)) throw error;
        ctx.log.info('wallet.issued_ref_not_writable', { code: error.code });
        return null;
      });
      writable = async (candidate) =>
        current !== null && isSamsung(current) && sameCertificate(current, candidate);
    } else if (row.current_revision === row.revision) writable = async () => true;
    else {
      const currentRow = await findSamsungIssuedRefCredential(ctx.env.DB, {
        ...pinned,
        accountRevision: row.current_revision,
        operated: false,
      });
      const current = currentRow ? await decryptAccount(ctx, currentRow) : null;
      writable = async (candidate) =>
        current !== null && isSamsung(current) && sameCertificate(current, candidate);
    }
  }
  const [first, ...laterAll] = found;
  if (!first) return null;
  // Only a later version of the same card follows a pinned one (as in the tombstone reader).
  const firstIdentity = await providerIdentityHash(first, row.card_type ?? undefined);
  const later: Samsung[] = [];
  for (const next of laterAll)
    if ((await providerIdentityHash(next, row.card_type ?? undefined)) === firstIdentity)
      later.push(next);
  return {
    ...material(row.id, row.revision, first, row.card_type),
    writable: await writable(first),
    later: await Promise.all(
      later.map(async (next) => ({
        ...material(row.id, row.revision, next, row.card_type),
        writable: await writable(next),
      })),
    ),
  };
}
