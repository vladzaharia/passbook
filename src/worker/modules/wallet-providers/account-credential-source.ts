import {
  type GoogleWalletCredentials,
  GoogleWalletCredentialsSchema,
  type SamsungWalletCredentials,
  SamsungWalletCredentialsSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { credentialAad, decryptSecretText, loadKekRing } from '../../platform/crypto.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import {
  corrupt,
  type KeyOnlyAccount,
  type StoredCredentials,
} from './account-credential-material.ts';
import {
  type EnrolmentRef,
  findCurrentSourceVersion,
  findEnrolmentSource,
  findPinnedVersions,
  type SourceVersionRow,
} from './repo-account-source.ts';
import { samsungCardMap } from './samsung-cards.ts';

/** What a version envelope holds: the provider secret only; the HMAC key stays with the enrolment. */
export type SourceCredentials =
  | { provider: 'google'; credentials: GoogleWalletCredentials }
  | { provider: 'samsung'; credentials: SamsungWalletCredentials };

export type OpenedVersion = SourceCredentials & {
  versionId: string;
  credentialId: string;
  identityHash: string;
  revoked: boolean;
};

/** Google: the issuer. Samsung: the partner (the card is per type, in the version's card_map). */
export function credentialIdentityHash(source: SourceCredentials): Promise<string> {
  return sha256Hex(
    canonicalJson(
      source.provider === 'google'
        ? { provider: 'google', issuerId: source.credentials.issuerId }
        : { provider: 'samsung', partnerId: source.credentials.partnerId },
    ),
  );
}

const bytes = (value: SourceVersionRow['iv']): Uint8Array => {
  if (value === null) throw corrupt();
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
};

/**
 * Decrypts one version for an enrolment of `owner`. The credential must be the platform's or the
 * owner's own, and the secret must carry the identity the rows claim: the stored hashes are
 * caller-written, so the decrypted secret is the authority.
 */
export async function openSourceVersion(
  ctx: ServiceContext,
  owner: EnrolmentRef,
  row: SourceVersionRow,
): Promise<OpenedVersion> {
  const own =
    (row.scope === 'platform' && row.credential_org_id === null) ||
    (row.scope === 'org' && row.credential_org_id === owner.orgId);
  if (!own || row.mode !== owner.mode || row.provider !== owner.provider) throw corrupt();
  let source: SourceCredentials;
  try {
    const text = await decryptSecretText(
      await loadKekRing(ctx.env),
      {
        kekVersion: row.kek_version,
        iv: bytes(row.iv),
        wrappedDek: bytes(row.wrapped_dek),
        ciphertext: bytes(row.ciphertext),
      },
      credentialAad(
        row.version_id,
        row.credential_org_id,
        `wallet-credential:${row.credential_id}:${row.scope}:${row.mode}:${row.provider}`,
      ),
    );
    const decoded = JSON.parse(text) as {
      version?: unknown;
      provider?: unknown;
      credentials?: unknown;
    };
    if (decoded?.version !== 1 || decoded.provider !== row.provider) throw corrupt();
    if (row.provider === 'google') {
      const parsed = GoogleWalletCredentialsSchema.safeParse(decoded.credentials);
      if (!parsed.success) throw corrupt();
      source = { provider: 'google', credentials: parsed.data };
    } else {
      const parsed = SamsungWalletCredentialsSchema.safeParse(decoded.credentials);
      if (!parsed.success) throw corrupt();
      source = { provider: 'samsung', credentials: parsed.data };
    }
  } catch {
    // Crypto and parse errors carry no detail the caller may see.
    throw corrupt();
  }
  const identityHash = await credentialIdentityHash(source);
  if (identityHash !== row.version_identity || identityHash !== row.credential_identity)
    throw corrupt();
  if (source.provider === 'samsung') {
    // The version's card map is the card allow-list: each card the secret names must equal the map's entry for its type.
    let cards: unknown;
    try {
      cards = JSON.parse(row.card_map);
    } catch {
      throw corrupt();
    }
    const stored = (cards && typeof cards === 'object' ? cards : {}) as Record<string, unknown>;
    let wanted: Record<string, string>;
    try {
      wanted = await samsungCardMap(source.credentials);
    } catch {
      throw corrupt();
    }
    for (const [type, hash] of Object.entries(wanted)) if (stored[type] !== hash) throw corrupt();
  }
  return {
    ...source,
    versionId: row.version_id,
    credentialId: row.credential_id,
    identityHash,
    revoked: row.revoked_at !== null,
  };
}

function merge(
  stored: StoredCredentials | KeyOnlyAccount,
  source: OpenedVersion,
): StoredCredentials {
  if (stored.provider === 'google' && source.provider === 'google')
    return {
      version: 1,
      provider: 'google',
      credentials: source.credentials,
      objectIdHmacKey: stored.objectIdHmacKey,
      credentialVersionId: source.versionId,
    };
  if (stored.provider === 'samsung' && source.provider === 'samsung')
    return { version: 1, provider: 'samsung', credentials: source.credentials };
  throw corrupt();
}

/** An envelope with no secret of its own (own key only) is not a credential without a source. */
function full(stored: StoredCredentials | KeyOnlyAccount): StoredCredentials {
  if (stored.credentials === null) throw corrupt();
  return stored;
}

export const enrolmentOf = (row: {
  id: string;
  org_id: string;
  mode: EnrolmentRef['mode'];
  provider: EnrolmentRef['provider'];
}): EnrolmentRef => ({ id: row.id, orgId: row.org_id, mode: row.mode, provider: row.provider });

export type SourcePin =
  /** The enrolment's source now. `activeOnly` refuses a revoked source (issuance), callbacks do not. */
  | { current: true; activeOnly: boolean }
  /** The version an operation, reference or tombstone was made under; NULL is legacy. */
  | { versionId: string | null };

/**
 * Replaces the provider secret of a legacy envelope with the enrolment's source credential. Only the
 * enrolment's own secret resolves, and never through an identity hash: the source is named by the
 * enrolment row, a pin by a version of a credential of the same org or the platform. An enrolment
 * with no source, or a NULL pin, is legacy and keeps its envelope (the HMAC key always stays there).
 */
export async function applyEnrolmentSource(
  ctx: ServiceContext,
  owner: EnrolmentRef,
  stored: StoredCredentials | KeyOnlyAccount,
  pin: SourcePin,
): Promise<StoredCredentials> {
  const enrolment = await findEnrolmentSource(ctx.env.DB, owner);
  if (!enrolment) throw corrupt();
  if ('versionId' in pin) {
    if (pin.versionId === null) return full(stored);
    const [row] = await findPinnedVersions(ctx.env.DB, owner, pin.versionId, false);
    if (!row) throw corrupt();
    return merge(stored, await openSourceVersion(ctx, owner, row));
  }
  if (!enrolment.source_id) return full(stored);
  const row = await findCurrentSourceVersion(ctx.env.DB, owner);
  if (!row || row.credential_id !== enrolment.source_id) throw corrupt();
  const opened = await openSourceVersion(ctx, owner, row);
  if (opened.identityHash !== enrolment.account_identity || (pin.activeOnly && opened.revoked))
    throw corrupt();
  return merge(stored, opened);
}

/** The pinned version's secret, then those of later versions of its credential (certificate rotation). */
export async function historicalSources(
  ctx: ServiceContext,
  owner: EnrolmentRef,
  stored: StoredCredentials | KeyOnlyAccount,
  versionId: string,
): Promise<StoredCredentials[]> {
  const rows = await findPinnedVersions(ctx.env.DB, owner, versionId, true);
  const [pinned, ...later] = rows;
  if (!pinned) throw corrupt();
  const found = [merge(stored, await openSourceVersion(ctx, owner, pinned))];
  for (const row of later) {
    try {
      found.push(merge(stored, await openSourceVersion(ctx, owner, row)));
    } catch {
      ctx.log.warn('wallet.credential_version_unreadable', {
        code: 'WALLET_CREDENTIALS_UNAVAILABLE',
      });
    }
  }
  return found;
}
