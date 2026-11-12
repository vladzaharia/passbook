import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  completeWalletOperation,
  getWalletInstanceById,
  retireWalletInstance,
} from './instance.ts';
import type {
  WalletClaimRef,
  WalletCredentialKeysetProof,
  WalletOperation,
  WalletOperationRef,
  WalletProviderResult,
} from './instance-types.ts';
import { isCredentialKeysetCommitment } from './instance-types.ts';
import { retirementReconciled } from './repo-instance-retirement.ts';
import type { WalletSyncRunResult } from './sync-operation-context.ts';

/** Idempotent crash recovery: a Samsung tombstone must survive the eventual pass deletion. */
export async function finishWalletProviderRetirement(
  ctx: ServiceContext,
  ref: WalletOperationRef & WalletCredentialKeysetProof,
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  ref = { ...ref };
  if (
    !isCredentialKeysetCommitment(ref.credentialKeysetCommitment) ||
    (await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== ref.credentialKeysetCommitment
  )
    return false;
  const instance = await getWalletInstanceById(ctx.env.DB, ref);
  if (
    !instance ||
    instance.desiredVersion !== ref.version ||
    instance.credentialKeysetCommitment !== ref.credentialKeysetCommitment
  )
    return false;
  if (instance.lifecycle === 'retired') return retirementReconciled(ctx.env.DB, ref);
  if (instance.lifecycle !== 'revoked') return false;
  // A previously disclosed Save JWT may be replayable after inactivation. Until a provider-
  // verified replay boundary exists, acceptance of INACTIVE alone cannot authorize hard purge.
  if (instance.provider === 'google') return false;
  if (
    instance.provider === 'samsung' &&
    !(await persistSamsungTombstone(ctx, {
      instanceId: ref.instanceId,
      orgId: ref.orgId,
      mode: ref.mode,
      operationVersion: ref.version,
      credentialKeysetCommitment: ref.credentialKeysetCommitment,
    }))
  )
    return false;
  if ((await requireCredentialRefKeyset(ctx.env.DB, ctx.env)) !== ref.credentialKeysetCommitment)
    return false;
  if (instance.retirementRequestedAt === null) return retirementReconciled(ctx.env.DB, ref);
  return retireWalletInstance(ctx.env.DB, { ...ref, now: ctx.clock.now() });
}

export async function completeWalletSyncOperation(
  ctx: ServiceContext,
  claim: WalletClaimRef,
  op: WalletOperation,
  result: WalletProviderResult,
): Promise<WalletSyncRunResult> {
  const state = await completeWalletOperation(ctx, { ...claim, now: ctx.clock.now(), result });
  if (state === null) return 'uncertain';
  if (state === 'succeeded' && op.kind === 'revoke') {
    await finishWalletProviderRetirement(ctx, claim);
  }
  return 'completed';
}
