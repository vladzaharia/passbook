import type { Mode } from '../../../shared/contracts/common.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  readConfiguredWalletProviderCredentials,
  readSamsungPromotedRefreshCredentials,
  readWalletProviderRetirementCredentials,
  snapshotWalletCredentialContext,
  type WalletProviderCredentialSnapshot,
} from './account-service.ts';
import { type GoogleValidatedAccount, validateGoogleAccount } from './google-credentials.ts';
import { providerIdentityHash } from './projection-contract.ts';
import { isCurrentApprovedProjection } from './projection-current.ts';
import { assertWalletProviderEnabled, assertWalletProviderRevokes } from './provider-policy.ts';
import { releaseCardType } from './repo-card-type.ts';
import { type ValidatedSamsungCredentials, validateSamsungCredentials } from './samsung.ts';

export type Provider = 'google' | 'samsung';
type GoogleSnapshot = Extract<WalletProviderCredentialSnapshot, { provider: 'google' }>;
type SamsungSnapshot = Extract<WalletProviderCredentialSnapshot, { provider: 'samsung' }>;

/** Server-authorized projection, never client authority. */
export interface WalletRuntimeScope {
  orgId: string;
  mode: Mode;
  accountId: string;
  accountRevision: number;
  /** The account epoch the operation recorded: with it, a same-identity rotation does not stale the scope. */
  accountEpoch?: number;
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
      /** Absent means 1; the SQL target fails closed for a successor. */
      channelEpoch: number;
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
  /** True for an inbound callback, which may use a ref's initial window; sync needs a promoted ref. */
  inbound: boolean;
}

/**
 * Google creating or updating a class or object, minting a save link or deriving ids: the scope's
 * release must still be the current approved one, and the enrolment must still issue. Which operation
 * may act is fenced by the caller's `assertCurrent`.
 */
export interface RuntimeIssuancePurpose {
  kind: 'issuance';
}

/** Samsung building an offer's Data Fetch link: Google's `issuance` rules (current release, enrolment issues). */
export interface RuntimeSamsungIssuancePurpose {
  kind: 'samsung-issuance';
}
export const SAMSUNG_ISSUANCE: RuntimeSamsungIssuancePurpose = { kind: 'samsung-issuance' };

export type RuntimeCredentialPurpose =
  | RuntimeRetirementPurpose
  | RuntimeRefreshPurpose
  | RuntimeIssuancePurpose
  | RuntimeSamsungIssuancePurpose;

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
      accountEpoch,
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
      (accountEpoch !== undefined && (!Number.isSafeInteger(accountEpoch) || accountEpoch < 1)) ||
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
      ...(accountEpoch === undefined ? {} : { accountEpoch }),
      providerIdentityHash,
      providerReleaseId,
    };
  } catch {
    throw runtimeAccountUnavailable();
  }
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
  // Every provider credential read, hence every outbound provider call, passes this gate. A revoke reads under
  // `retirement`, which draining still allows.
  if (purpose?.kind === 'retirement') assertWalletProviderRevokes(provider, scope.mode);
  else assertWalletProviderEnabled(provider, scope.mode);
  // A developer org never reads a provider credential, so it never mints, signs or calls out.
  await assertNotPreviewOnly(ctx.env.DB, scope.orgId);
  try {
    await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
    if (!purpose) throw runtimeAccountUnavailable();
    let account: WalletProviderCredentialSnapshot | null;
    if (purpose.kind === 'retirement') {
      if (purpose.target.provider !== provider) throw runtimeAccountUnavailable();
      account = await readWalletProviderRetirementCredentials(ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        accountId: scope.accountId,
        accountRevision: scope.accountRevision,
        authorityEpoch: scope.accountEpoch,
        projectionReleaseId: scope.providerReleaseId,
        instanceId: purpose.instanceId,
        operationId: purpose.operationId,
        version: purpose.version,
        claimHash: purpose.claimHash,
        ...purpose.target,
      });
    } else if (purpose.kind === 'issuance' || purpose.kind === 'samsung-issuance') {
      if (
        provider !== (purpose.kind === 'issuance' ? 'google' : 'samsung') ||
        !(await isCurrentApprovedProjection(ctx, {
          orgId: scope.orgId,
          mode: scope.mode,
          provider,
          accountId: scope.accountId,
          accountRevision: scope.accountRevision,
          accountEpoch: scope.accountEpoch,
          providerIdentityHash: scope.providerIdentityHash,
          releaseId: scope.providerReleaseId,
        }))
      )
        throw runtimeAccountUnavailable();
      account = await readConfiguredWalletProviderCredentials(
        ctx,
        { orgId: scope.orgId, mode: scope.mode, provider },
        scope.accountEpoch === undefined
          ? { accountId: scope.accountId, accountRevision: scope.accountRevision }
          : { accountId: scope.accountId, authorityEpoch: scope.accountEpoch },
      );
    } else {
      if (
        provider !== 'samsung' ||
        !(await isCurrentApprovedProjection(ctx, {
          orgId: scope.orgId,
          mode: scope.mode,
          provider,
          accountId: scope.accountId,
          accountRevision: scope.accountRevision,
          accountEpoch: scope.accountEpoch,
          providerIdentityHash: scope.providerIdentityHash,
          releaseId: scope.providerReleaseId,
        }))
      )
        throw runtimeAccountUnavailable();
      account = await readSamsungPromotedRefreshCredentials(ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        accountId: scope.accountId,
        accountRevision: scope.accountRevision,
        authorityEpoch: scope.accountEpoch,
        projectionReleaseId: scope.providerReleaseId,
        instanceId: purpose.instanceId,
        refHash: purpose.refHash,
        operationVersion: purpose.operationVersion,
        window: purpose.inbound,
      });
    }
    const cardType =
      provider === 'samsung'
        ? await releaseCardType(ctx.env.DB, scope.orgId, scope.providerReleaseId)
        : null;
    if (
      !account ||
      account.provider !== provider ||
      account.accountId !== scope.accountId ||
      (scope.accountEpoch === undefined
        ? account.revision !== scope.accountRevision
        : account.authorityEpoch !== scope.accountEpoch) ||
      (await providerIdentityHash(account, cardType ?? undefined)) !== scope.providerIdentityHash ||
      (account.provider === 'google' &&
        (!(account.objectIdHmacKey instanceof Uint8Array) ||
          account.objectIdHmacKey.byteLength < 32))
    ) {
      throw runtimeAccountUnavailable();
    }
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
  purpose?: RuntimeCredentialPurpose,
): Promise<{
  account: GoogleValidatedAccount;
  hmacKey: Uint8Array;
  credentialVersionId: string | null;
}> {
  ctx = snapshotWalletCredentialContext(ctx);
  scope = copyRuntimeScope(scope);
  const value = await snapshot(ctx, scope, 'google', purpose);
  try {
    const account = await validateGoogleAccount(value.credentials);
    return {
      account,
      hmacKey: value.objectIdHmacKey,
      credentialVersionId: value.credentialVersionId,
    };
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
    const cardType = await releaseCardType(ctx.env.DB, scope.orgId, scope.providerReleaseId);
    const account = await validateSamsungCredentials(
      value.credentials,
      ctx.clock.now(),
      cardType ?? undefined,
    );
    return account;
  } catch {
    throw runtimeAccountUnavailable();
  }
}
