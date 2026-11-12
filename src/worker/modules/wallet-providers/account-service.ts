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
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import { randomBytes, toBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';
import {
  assertCredentialKeyset,
  corrupt,
  decryptAccount,
  type StoredCredentials,
  snapshotWalletCredentialContext,
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
import { validateSamsungCredentials } from './samsung-credentials.ts';

export type { WalletProviderCredentialSnapshot } from './account-credential-material.ts';
export { snapshotWalletCredentialContext } from './account-credential-material.ts';
export type { SamsungTombstoneVerification } from './account-credential-read.ts';
export {
  readConfiguredWalletProviderCredentials,
  readGoogleCallbackVerification,
  readSamsungPromotedRefreshCredentials,
  readSamsungTombstoneVerification,
  readWalletProviderRetirementCredentials,
} from './account-credential-read.ts';

export type {
  SamsungPromotedRefreshProof,
  WalletProviderRetirementProof,
} from './repo-accounts.ts';

const changed = () =>
  new ConflictError(
    'The wallet provider account changed. Reload and retry.',
    'WALLET_ACCOUNT_CONFLICT',
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
    else await validateSamsungCredentials(input.credentials, now);
  } catch {
    throw invalid();
  }
}

function readiness(scope: WalletProviderScope, row: AccountRow | null): WalletProviderReadiness {
  const state = !row?.credential_id ? 'absent' : row.revoked_at !== null ? 'revoked' : 'configured';
  return {
    ...scope,
    accountId: row?.id ?? null,
    revision: row?.revision ?? 0,
    state,
    externalApprovalVerified: false,
    issuance: walletProviderIssuance(scope.provider),
    updatedAt: row?.updated_at ?? null,
  };
}

async function currentAccount(
  ctx: ServiceContext,
  scope: WalletProviderScope,
  expectedId: string,
  credentialKeysetCommitment: string,
): Promise<AccountRow> {
  const row = await findAccountWithCredentialKeyset(ctx.env.DB, scope, credentialKeysetCommitment);
  await assertCredentialKeyset(ctx, credentialKeysetCommitment);
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
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  return readiness(
    parsed.data,
    await currentAccount(ctx, parsed.data, row.id, credentialKeysetCommitment),
  );
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
  credentialKeysetCommitment: string,
): Promise<never> {
  if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
    throw new ForbiddenError();
  await assertCredentialKeyset(ctx, credentialKeysetCommitment);
  const row = await findAccount(ctx.env.DB, scope);
  if (row) await currentAccount(ctx, scope, row.id, credentialKeysetCommitment);
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
  await validateCredentials(data, ctx.clock.now());
  const row = await findAccount(ctx.env.DB, scope);
  if ((row?.revision ?? 0) !== data.expectedRevision) throw changed();
  const credentialKeysetCommitment = row
    ? await requireCredentialRefKeyset(ctx.env.DB, ctx.env)
    : await ensureCredentialRefKeyset(ctx.env.DB, ctx.env);
  const current = row ? await currentAccount(ctx, scope, row.id, credentialKeysetCommitment) : null;
  if (current && current.revision !== data.expectedRevision) throw changed();
  const previous = current?.credential_id ? await decryptAccount(ctx, current) : null;
  await assertCredentialKeyset(ctx, credentialKeysetCommitment);
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
  const accountId = row?.id ?? ctx.ids.id();
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
  await assertCredentialKeyset(ctx, credentialKeysetCommitment);
  if (
    !(await saveAccountConfiguration(ctx, authority, scope, {
      accountId,
      isNew: !row,
      expectedRevision: data.expectedRevision,
      credentialId,
      eventId: ctx.ids.id(),
      envelope,
      credentialKeysetCommitment,
    }))
  )
    return failedWrite(ctx, authority, scope, credentialKeysetCommitment);
  return readiness(scope, await currentAccount(ctx, scope, accountId, credentialKeysetCommitment));
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
  const row = await findAccount(ctx.env.DB, scope);
  if (!row?.credential_id || row.revision !== data.expectedRevision || row.revoked_at !== null)
    throw changed();
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  const currentAccountRow = await currentAccount(ctx, scope, row.id, credentialKeysetCommitment);
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
      credentialKeysetCommitment,
    }))
  ) {
    if (!(await tenantPassAuthorityValid(ctx.env.DB, authority, ctx.clock.now())))
      throw new ForbiddenError();
    await assertCredentialKeyset(ctx, credentialKeysetCommitment);
    const current = await findAccount(ctx.env.DB, scope);
    if (current) await currentAccount(ctx, scope, current.id, credentialKeysetCommitment);
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
  return readiness(scope, await currentAccount(ctx, scope, row.id, credentialKeysetCommitment));
}
