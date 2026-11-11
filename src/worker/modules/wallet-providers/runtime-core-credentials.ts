import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  readSamsungPromotedRefreshCredentials,
  readWalletProviderRetirementCredentials,
  snapshotWalletCredentialContext,
  type WalletProviderCredentialSnapshot,
} from './account-service.ts';
import { type GoogleValidatedAccount, validateGoogleAccount } from './google-credentials.ts';
import { providerIdentityHash } from './projection-contract.ts';
import { isCurrentApprovedProjection } from './projection-current.ts';
import { assertWalletProviderEnabled } from './provider-policy.ts';
import { type ValidatedSamsungCredentials, validateSamsungCredentials } from './samsung.ts';

export type Provider = 'google' | 'samsung';
type GoogleSnapshot = Extract<WalletProviderCredentialSnapshot, { provider: 'google' }>;
type SamsungSnapshot = Extract<WalletProviderCredentialSnapshot, { provider: 'samsung' }>;

/** Server-authorized projection and the original credential-keyset proof, never client authority. */
export interface WalletRuntimeScope {
  orgId: string;
  mode: Mode;
  accountId: string;
  accountRevision: number;
  /** Captured before creating the provider identity; never replaced by a later current keyset. */
  credentialKeysetCommitment: string;
  providerIdentityHash: string;
  /** Current native projection, distinct from the original class identity release. */
  providerReleaseId: string;
}

export interface WalletRetirementClaim {
  instanceId: string;
  operationId: string;
  version: number;
  claimHandle: string;
}

export type RetirementTarget =
  | {
      provider: 'google';
      passId: string;
      identityProjectionReleaseId: string;
      credentialGeneration: number;
    }
  | { provider: 'samsung'; refHash: string };

export interface RuntimeRetirementPurpose {
  kind: 'retirement';
  instanceId: string;
  operationId: string;
  version: number;
  claimHash: string;
  target: RetirementTarget;
}

export interface SamsungRuntimeRefresh {
  instanceId: string;
  refHash: string;
  operationVersion: number;
}

export interface RuntimeRefreshPurpose extends SamsungRuntimeRefresh {
  kind: 'refresh';
}

export type RuntimeCredentialPurpose = RuntimeRetirementPurpose | RuntimeRefreshPurpose;

/** A provider call may have reached the provider even if the final account fence fails. */
export class WalletRuntimeError extends Error {
  readonly code: 'account_unavailable' | 'provider_failure';
  readonly ambiguous: boolean;

  constructor(code: 'account_unavailable' | 'provider_failure', ambiguous = false) {
    super(
      code === 'account_unavailable'
        ? 'Wallet provider account is unavailable.'
        : 'Wallet provider operation failed.',
    );
    this.name = 'WalletRuntimeError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export function runtimeAccountUnavailable(ambiguous = false): WalletRuntimeError {
  return new WalletRuntimeError('account_unavailable', ambiguous);
}

export function copyRuntimeScope(scope: WalletRuntimeScope): WalletRuntimeScope {
  try {
    const {
      orgId,
      mode,
      accountId,
      accountRevision,
      credentialKeysetCommitment,
      providerIdentityHash,
      providerReleaseId,
    } = scope;
    if (
      typeof orgId !== 'string' ||
      !orgId.trim() ||
      (mode !== 'live' && mode !== 'test') ||
      typeof accountId !== 'string' ||
      !accountId.trim() ||
      !Number.isSafeInteger(accountRevision) ||
      accountRevision < 1 ||
      typeof credentialKeysetCommitment !== 'string' ||
      !/^[0-9a-f]{64}$/.test(credentialKeysetCommitment) ||
      typeof providerIdentityHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(providerIdentityHash) ||
      typeof providerReleaseId !== 'string' ||
      !providerReleaseId.trim()
    ) {
      throw runtimeAccountUnavailable();
    }
    return {
      orgId,
      mode,
      accountId,
      accountRevision,
      credentialKeysetCommitment,
      providerIdentityHash,
      providerReleaseId,
    };
  } catch {
    throw runtimeAccountUnavailable();
  }
}

export async function assertRuntimeCredentialKeyset(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
): Promise<void> {
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== scope.credentialKeysetCommitment)
    throw runtimeAccountUnavailable();
}

async function snapshot(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  provider: 'google',
  purpose?: RuntimeCredentialPurpose,
): Promise<GoogleSnapshot>;
async function snapshot(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  provider: 'samsung',
  purpose?: RuntimeCredentialPurpose,
): Promise<SamsungSnapshot>;
async function snapshot(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  provider: Provider,
  purpose?: RuntimeCredentialPurpose,
): Promise<WalletProviderCredentialSnapshot> {
  // Every provider credential read, hence every outbound provider call, passes this gate.
  assertWalletProviderEnabled(provider);
  try {
    // Unpurposed reads have no credential path yet; the provider track that enables issuance adds one.
    if (!purpose) throw runtimeAccountUnavailable();
    let account: WalletProviderCredentialSnapshot | null;
    if (purpose.kind === 'retirement') {
      if (purpose.target.provider !== provider) throw runtimeAccountUnavailable();
      account = await readWalletProviderRetirementCredentials(ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        accountId: scope.accountId,
        accountRevision: scope.accountRevision,
        credentialKeysetCommitment: scope.credentialKeysetCommitment,
        projectionReleaseId: scope.providerReleaseId,
        instanceId: purpose.instanceId,
        operationId: purpose.operationId,
        version: purpose.version,
        claimHash: purpose.claimHash,
        ...purpose.target,
      });
    } else {
      if (
        provider !== 'samsung' ||
        !(await isCurrentApprovedProjection(ctx, {
          orgId: scope.orgId,
          mode: scope.mode,
          provider,
          accountId: scope.accountId,
          accountRevision: scope.accountRevision,
          providerIdentityHash: scope.providerIdentityHash,
          credentialKeysetCommitment: scope.credentialKeysetCommitment,
          releaseId: scope.providerReleaseId,
        }))
      )
        throw runtimeAccountUnavailable();
      account = await readSamsungPromotedRefreshCredentials(ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        accountId: scope.accountId,
        accountRevision: scope.accountRevision,
        credentialKeysetCommitment: scope.credentialKeysetCommitment,
        projectionReleaseId: scope.providerReleaseId,
        instanceId: purpose.instanceId,
        refHash: purpose.refHash,
        operationVersion: purpose.operationVersion,
      });
    }
    if (
      !account ||
      account.provider !== provider ||
      account.accountId !== scope.accountId ||
      account.revision !== scope.accountRevision ||
      account.credentialKeysetCommitment !== scope.credentialKeysetCommitment ||
      (await providerIdentityHash(account)) !== scope.providerIdentityHash ||
      (account.provider === 'google' &&
        (!(account.objectIdHmacKey instanceof Uint8Array) ||
          account.objectIdHmacKey.byteLength < 32))
    ) {
      throw runtimeAccountUnavailable();
    }
    await assertRuntimeCredentialKeyset(ctx, scope);
    return account;
  } catch {
    // Account service/decryption exceptions must never escape with credential material.
    throw runtimeAccountUnavailable();
  }
}

export async function runtimeCredentialCurrent(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  provider: Provider,
  purpose?: RuntimeCredentialPurpose,
): Promise<void> {
  if (provider === 'google') await snapshot(ctx, scope, 'google', purpose);
  else await snapshot(ctx, scope, 'samsung', purpose);
}

export async function runtimeGoogleAccount(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  retirement?: RuntimeRetirementPurpose,
): Promise<{
  account: GoogleValidatedAccount;
  hmacKey: Uint8Array;
}> {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  const value = await snapshot(ctx, scope, 'google', retirement);
  try {
    const account = await validateGoogleAccount(value.credentials);
    await assertRuntimeCredentialKeyset(ctx, scope);
    return { account, hmacKey: value.objectIdHmacKey };
  } catch {
    throw runtimeAccountUnavailable();
  }
}

export async function runtimeSamsungAccount(
  ctx: ServiceContext,
  scope: WalletRuntimeScope,
  purpose?: RuntimeCredentialPurpose,
): Promise<ValidatedSamsungCredentials> {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  const value = await snapshot(ctx, scope, 'samsung', purpose);
  try {
    const account = await validateSamsungCredentials(value.credentials, ctx.clock.now());
    await assertRuntimeCredentialKeyset(ctx, scope);
    return account;
  } catch {
    throw runtimeAccountUnavailable();
  }
}
