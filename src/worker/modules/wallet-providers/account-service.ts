import {
  type ConfigureWalletProviderAccount,
  ConfigureWalletProviderAccountSchema,
  type RevokeWalletProviderAccount,
  RevokeWalletProviderAccountSchema,
  type WalletProviderReadiness,
  type WalletProviderScope,
  WalletProviderScopeSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { randomBytes, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';
import {
  corrupt,
  decryptAccount,
  type StoredCredentials,
  snapshotWalletCredentialContext,
  storedIdentityHash,
} from './account-credential-material.ts';
import { validateGoogleAccount } from './google-credentials.ts';
import { walletProviderIssuance } from './provider-policy.ts';
import {
  type AccountRow,
  findAccount,
  findAccountWithCredentialKeyset,
  hasUnretiredInstances,
  saveAccountConfiguration,
  transitionAccount,
} from './repo-accounts.ts';
import { isNewModelAccount } from './repo-enrolments.ts';
import { validateSamsungCredentials } from './samsung-credentials.ts';

export type { WalletProviderCredentialSnapshot } from './account-credential-material.ts';
export { snapshotWalletCredentialContext } from './account-credential-material.ts';
export type { SamsungTombstoneVerification } from './account-credential-read.ts';
export {
  readConfiguredWalletProviderCredentials,
  readGoogleCallbackVerification,
  readSamsungIssuedRefVerification,
  readSamsungPromotedRefreshCredentials,
  readSamsungTombstoneVerification,
  readWalletProviderRetirementCredentials,
} from './account-credential-read.ts';

export type {
  SamsungPromotedRefreshProof,
  WalletProviderRetirementProof,
} from './repo-accounts.ts';

import { hasCredential } from './account-presence.ts';

const changed = () =>
  new ConflictError(
    'The wallet provider account changed. Reload and retry.',
    'WALLET_ACCOUNT_CONFLICT',
  );
/** A row on the credential and enrolment model is written through those routes (410 for the old form). */
const moved = () =>
  new AppError(
    'WALLET_ACCOUNT_MOVED',
    410,
    'Wallet provider settings moved to credentials and enrolments.',
  );
const invalid = () =>
  new ValidationError('Invalid wallet provider credentials.', [], 'WALLET_CREDENTIALS_INVALID');

function scoped(auth: SessionAuth, scope: WalletProviderScope): void {
  if (auth?.kind !== 'session') throw new ForbiddenError();
  if (auth.mode !== scope.mode)
    throw new ForbiddenError(
      'The requested mode does not match the session.',
      'WALLET_MODE_MISMATCH',
    );
}

async function validateCredentials(
  input: ConfigureWalletProviderAccount,
  now: number,
): Promise<void> {
  try {
    if (input.provider === 'google') await validateGoogleAccount(input.credentials);
    else {
      // Per-type cards live in the credential versions; this legacy path cannot keep them append-only.
      if (input.credentials.cardIds) throw invalid();
      await validateSamsungCredentials(input.credentials, now);
    }
  } catch {
    throw invalid();
  }
}

/**
 * `configured` says a credential is present, on either model; whether the provider issues is the enrolment's
 * on/off/held/revoked state (enrolment-read.ts), which the admin UI shows separately from this legacy route.
 */
function readiness(scope: WalletProviderScope, row: AccountRow | null): WalletProviderReadiness {
  const state =
    !row || !hasCredential(row) ? 'absent' : row.revoked_at !== null ? 'revoked' : 'configured';
  return {
    ...scope,
    accountId: row?.id ?? null,
    revision: row?.revision ?? 0,
    state,
    externalApprovalVerified: false,
    issuance: walletProviderIssuance(scope.provider, scope.mode),
    updatedAt: row?.updated_at ?? null,
  };
}

async function currentAccount(
  ctx: ServiceContext,
  scope: WalletProviderScope,
  expectedId: string,
): Promise<AccountRow> {
  const row = await findAccountWithCredentialKeyset(ctx.env.DB, scope);
  if (!row || row.id !== expectedId) throw corrupt();
  return row;
}

/** Internal readiness; callers exposing this to tenants must authorize the scope first. */
export async function getWalletProviderReadiness(
  ctx: ServiceContext,
  scope: WalletProviderScope,
): Promise<WalletProviderReadiness> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = WalletProviderScopeSchema.safeParse(scope);
  if (!parsed.success) throw new ValidationError();
  const row = await findAccount(ctx.env.DB, parsed.data);
  if (!row) return readiness(parsed.data, null);
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  return readiness(parsed.data, await currentAccount(ctx, parsed.data, row.id));
}

/** Authorized, mode-matched administrative read. */
export async function getWalletProviderAccount(
  ctx: ServiceContext,
  auth: SessionAuth,
  scope: WalletProviderScope,
): Promise<WalletProviderReadiness> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = WalletProviderScopeSchema.safeParse(scope);
  if (!parsed.success) throw new ValidationError();
  scoped(auth, parsed.data);
  await tenantAuthorityOf(ctx, auth, parsed.data.orgId, 'integrations:read');
  return getWalletProviderReadiness(ctx, parsed.data);
}

async function failedWrite(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  scope: WalletProviderScope,
): Promise<never> {
  if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
    throw new ForbiddenError();
  if (await isNewModelAccount(ctx.env.DB, scope.orgId, scope.mode, scope.provider)) throw moved();
  const row = await findAccount(ctx.env.DB, scope);
  if (row) await currentAccount(ctx, scope, row.id);
  throw changed();
}

/** Configure or rotate credentials; publication evidence remains separate and revision-bound. */
export async function configureWalletProviderAccount(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: ConfigureWalletProviderAccount,
): Promise<WalletProviderReadiness> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = ConfigureWalletProviderAccountSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const data = parsed.data;
  const scope: WalletProviderScope = {
    orgId: data.orgId,
    mode: data.mode,
    provider: data.provider,
  };
  scoped(auth, scope);
  const authority = await tenantAuthorityOf(ctx, auth, scope.orgId, 'integrations:manage');
  if (authority.kind !== 'session') throw new ForbiddenError();
  if (await isNewModelAccount(ctx.env.DB, scope.orgId, scope.mode, scope.provider)) throw moved();
  await validateCredentials(data, ctx.clock.now());
  // The legacy route only rotates an existing envelope; a new account is an enrolment on an org credential.
  const row = await findAccount(ctx.env.DB, scope);
  if (!row?.credential_id) throw moved();
  if (row.revision !== data.expectedRevision) throw changed();
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const current = await currentAccount(ctx, scope, row.id);
  if (current.revision !== data.expectedRevision) throw changed();
  const previous = current.credential_id ? await decryptAccount(ctx, current) : null;
  let stored: StoredCredentials;
  if (data.provider === 'google') {
    if (
      previous &&
      (previous.provider !== 'google' ||
        previous.credentials.issuerId !== data.credentials.issuerId)
    )
      throw new ConflictError(
        'A wallet account issuer cannot be changed.',
        'WALLET_IDENTITY_IMMUTABLE',
      );
    stored = {
      version: 1,
      provider: 'google',
      credentials: data.credentials,
      objectIdHmacKey:
        previous?.provider === 'google' ? previous.objectIdHmacKey : toBase64Url(randomBytes(32)),
    };
  } else {
    if (
      previous &&
      (previous.provider !== 'samsung' ||
        previous.credentials.partnerId !== data.credentials.partnerId ||
        previous.credentials.cardId !== data.credentials.cardId)
    )
      throw new ConflictError(
        'A wallet account partner or card cannot be changed.',
        'WALLET_IDENTITY_IMMUTABLE',
      );
    stored = { version: 1, provider: 'samsung', credentials: data.credentials };
  }
  const accountId = row.id;
  const credentialId = ctx.ids.id();
  const envelope = await encryptSecret(
    await loadKekRing(ctx.env),
    JSON.stringify(stored),
    credentialAad(
      credentialId,
      scope.orgId,
      `wallet-provider:${accountId}:${scope.mode}:${scope.provider}`,
    ),
  );
  if (
    !(await saveAccountConfiguration(ctx, authority, scope, {
      accountId,
      expectedRevision: data.expectedRevision,
      credentialId,
      identityHash: await storedIdentityHash(stored),
      eventId: ctx.ids.id(),
      envelope,
    }))
  )
    return failedWrite(ctx, authority, scope);
  return readiness(scope, await currentAccount(ctx, scope, accountId));
}

export async function revokeWalletProviderAccount(
  ctx: ServiceContext,
  auth: SessionAuth,
  input: RevokeWalletProviderAccount,
): Promise<WalletProviderReadiness> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = RevokeWalletProviderAccountSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();
  const data = parsed.data;
  const scope: WalletProviderScope = {
    orgId: data.orgId,
    mode: data.mode,
    provider: data.provider,
  };
  scoped(auth, scope);
  const authority = await tenantAuthorityOf(ctx, auth, scope.orgId, 'integrations:manage');
  if (authority.kind !== 'session') throw new ForbiddenError();
  if (await isNewModelAccount(ctx.env.DB, scope.orgId, scope.mode, scope.provider)) throw moved();
  const row = await findAccount(ctx.env.DB, scope);
  if (!row?.credential_id || row.revision !== data.expectedRevision || row.revoked_at !== null)
    throw changed();
  await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const currentAccountRow = await currentAccount(ctx, scope, row.id);
  if (
    currentAccountRow.revision !== data.expectedRevision ||
    currentAccountRow.credential_id !== row.credential_id ||
    currentAccountRow.revoked_at !== null
  )
    throw changed();
  if (
    !(await transitionAccount(ctx, authority, scope, {
      accountId: row.id,
      credentialId: row.credential_id,
      expectedRevision: data.expectedRevision,
      eventId: ctx.ids.id(),
      kind: 'revoke',
    }))
  ) {
    if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
      throw new ForbiddenError();
    if (await isNewModelAccount(ctx.env.DB, scope.orgId, scope.mode, scope.provider)) throw moved();
    const current = await findAccount(ctx.env.DB, scope);
    if (current) await currentAccount(ctx, scope, current.id);
    if (
      current?.id === row.id &&
      current.revision === data.expectedRevision &&
      current.revoked_at === null &&
      (await hasUnretiredInstances(ctx.env.DB, row.id))
    )
      throw new ConflictError(
        'Retire all provider instances before revoking this account.',
        'WALLET_ACCOUNT_INSTANCES_ACTIVE',
      );
    throw changed();
  }
  return readiness(scope, await currentAccount(ctx, scope, row.id));
}
