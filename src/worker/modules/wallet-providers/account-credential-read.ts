import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  type WalletProviderScope,
  WalletProviderScopeSchema,
} from '../../../shared/contracts/wallet-providers.ts';
import { ValidationError } from '../../platform/errors.ts';
import { fromBase64Url } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  assertCredentialKeyset,
  corrupt,
  credentialSnapshot,
  openAccount,
  snapshotWalletCredentialContext,
  type WalletProviderCredentialSnapshot,
} from './account-credential-material.ts';
import { applyEnrolmentSource, enrolmentOf } from './account-credential-source.ts';
import { walletEnrolmentIssues } from './provider-policy.ts';
import { findOperationPin } from './repo-account-source.ts';
import {
  findAccount,
  findAccountWithCredentialKeyset,
  findRetirementAccount,
  findSamsungPromotedRefreshAccount,
  type SamsungPromotedRefreshProof,
  type WalletProviderRetirementProof,
} from './repo-accounts.ts';
import { findEnrolmentGateRow } from './repo-enrolment-gate.ts';

export {
  readSamsungIssuedRefVerification,
  readSamsungTombstoneVerification,
  type SamsungTombstoneVerification,
} from './account-credential-historical.ts';

/** Server-only probe material; the caller must authorize the probe and fence provider evidence. */
export async function readConfiguredWalletProviderCredentials(
  ctx: ServiceContext,
  scope: WalletProviderScope,
  expected: { accountId: string; accountRevision: number; credentialKeysetCommitment: string },
): Promise<WalletProviderCredentialSnapshot | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const parsed = WalletProviderScopeSchema.safeParse(scope);
  const pinned = { ...expected };
  if (
    !parsed.success ||
    !IdSchema.safeParse(pinned.accountId).success ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    typeof pinned.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pinned.credentialKeysetCommitment)
  )
    throw new ValidationError();
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  const row = await findAccountWithCredentialKeyset(
    ctx.env.DB,
    parsed.data,
    pinned.credentialKeysetCommitment,
  );
  if (!row) {
    const existing = await findAccount(ctx.env.DB, parsed.data);
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    if (existing) throw corrupt();
    return null;
  }
  if (
    row.id !== pinned.accountId ||
    row.revision !== pinned.accountRevision ||
    (!row.credential_id && !row.hmac_ciphertext && row.provider !== 'samsung') ||
    row.revoked_at !== null
  ) {
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    return null;
  }
  // The one enrolment gate (provider-policy.ts): a new-model row issues only while On and not held.
  if (!walletEnrolmentIssues(row)) {
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    return null;
  }
  const stored = await applyEnrolmentSource(ctx, enrolmentOf(row), await openAccount(ctx, row), {
    current: true,
    activeOnly: true,
  });
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  return credentialSnapshot(row, stored, pinned.credentialKeysetCommitment);
}

/** Server-only callback verification material; never serialize, log, or use for issuance. */
export async function readGoogleCallbackVerification(
  ctx: ServiceContext,
  input: {
    orgId: string;
    mode: WalletProviderScope['mode'];
    accountId: string;
    accountRevision: number;
    credentialKeysetCommitment: string;
  },
): Promise<{ issuerId: string; objectIdHmacKey: Uint8Array } | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const pinned = { ...input };
  const scope = { orgId: pinned.orgId, mode: pinned.mode, provider: 'google' as const };
  if (
    !WalletProviderScopeSchema.safeParse(scope).success ||
    !IdSchema.safeParse(pinned.accountId).success ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    typeof pinned.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pinned.credentialKeysetCommitment)
  )
    throw new ValidationError();
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  const row = await findAccountWithCredentialKeyset(
    ctx.env.DB,
    scope,
    pinned.credentialKeysetCommitment,
  );
  if (!row) {
    // An account whose retained identities do not match this keyset is unavailable, not unknown.
    const existing = await findAccount(ctx.env.DB, scope);
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    if (existing) throw corrupt();
    return null;
  }
  if (
    row.id !== pinned.accountId ||
    row.revision !== pinned.accountRevision ||
    (!row.credential_id && !row.hmac_ciphertext && row.provider !== 'samsung') ||
    row.revoked_at !== null
  ) {
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    return null;
  }
  // A callback is verified for the enrolment's own source issuer, revoked or not: callbacks outlive it.
  const stored = await applyEnrolmentSource(ctx, enrolmentOf(row), await openAccount(ctx, row), {
    current: true,
    activeOnly: false,
  });
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  if (stored.provider !== 'google') throw corrupt();
  return {
    issuerId: stored.credentials.issuerId,
    objectIdHmacKey: fromBase64Url(stored.objectIdHmacKey),
  };
}

/** Server-only cleanup material; valid only for the exact current claimed revoke and its target. */
export async function readWalletProviderRetirementCredentials(
  ctx: ServiceContext,
  proof: WalletProviderRetirementProof,
): Promise<WalletProviderCredentialSnapshot | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const pinned = { ...proof };
  const scope = { orgId: pinned.orgId, mode: pinned.mode, provider: pinned.provider };
  const ids = [pinned.accountId, pinned.instanceId, pinned.operationId, pinned.projectionReleaseId];
  if (pinned.provider === 'google') ids.push(pinned.passId, pinned.identityProjectionReleaseId);
  if (
    !WalletProviderScopeSchema.safeParse(scope).success ||
    ids.some((id) => !IdSchema.safeParse(id).success) ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    !Number.isSafeInteger(pinned.version) ||
    pinned.version <= 0 ||
    !/^[0-9a-f]{64}$/.test(pinned.claimHash) ||
    typeof pinned.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pinned.credentialKeysetCommitment) ||
    (pinned.provider === 'google' &&
      (!Number.isSafeInteger(pinned.credentialGeneration) || pinned.credentialGeneration < 1)) ||
    (pinned.provider === 'samsung' && !/^[0-9a-f]{64}$/.test(pinned.refHash))
  )
    throw new ValidationError();
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  const row = await findRetirementAccount(ctx.env.DB, pinned, ctx.clock.now());
  const stored = row
    ? await applyEnrolmentSource(ctx, enrolmentOf(row), await openAccount(ctx, row), {
        versionId: await findOperationPin(ctx.env.DB, pinned.instanceId, {
          operationId: pinned.operationId,
        }),
      })
    : null;
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  return row && stored ? credentialSnapshot(row, stored, pinned.credentialKeysetCommitment) : null;
}

/** Server-only refresh material for an existing promoted Samsung ref, never a new offer. */
export async function readSamsungPromotedRefreshCredentials(
  ctx: ServiceContext,
  proof: SamsungPromotedRefreshProof,
): Promise<WalletProviderCredentialSnapshot | null> {
  ctx = snapshotWalletCredentialContext(ctx);
  const pinned = { ...proof };
  if (
    !WalletProviderScopeSchema.safeParse({
      orgId: pinned.orgId,
      mode: pinned.mode,
      provider: 'samsung',
    }).success ||
    [pinned.accountId, pinned.instanceId, pinned.projectionReleaseId].some(
      (id) => !IdSchema.safeParse(id).success,
    ) ||
    !Number.isSafeInteger(pinned.accountRevision) ||
    pinned.accountRevision <= 0 ||
    !Number.isSafeInteger(pinned.operationVersion) ||
    pinned.operationVersion <= 0 ||
    typeof pinned.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(pinned.credentialKeysetCommitment) ||
    !/^[0-9a-f]{64}$/.test(pinned.refHash)
  )
    throw new ValidationError();
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  const row = await findSamsungPromotedRefreshAccount(ctx.env.DB, pinned, ctx.clock.now());
  // A refresh is an outbound call: an Off or held enrolment stops it like any other issuance.
  if (
    row &&
    !walletEnrolmentIssues(
      await findEnrolmentGateRow(ctx.env.DB, 'samsung', pinned.orgId, pinned.mode),
    )
  ) {
    await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
    return null;
  }
  const stored = row
    ? await applyEnrolmentSource(ctx, enrolmentOf(row), await openAccount(ctx, row), {
        versionId: await findOperationPin(ctx.env.DB, pinned.instanceId, {
          version: pinned.operationVersion,
        }),
      })
    : null;
  await assertCredentialKeyset(ctx, pinned.credentialKeysetCommitment);
  return row && stored ? credentialSnapshot(row, stored, pinned.credentialKeysetCommitment) : null;
}
