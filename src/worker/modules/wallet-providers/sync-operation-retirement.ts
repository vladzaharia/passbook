import type { ServiceContext } from '../../platform/service-context.ts';
import { snapshotWalletCredentialContext } from './account-service.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  completeWalletOperation,
  getWalletInstanceById,
  getWalletOperation,
  retireWalletInstance,
} from './instance.ts';
import type {
  WalletClaimRef,
  WalletOperation,
  WalletOperationRef,
  WalletProviderResult,
} from './instance-types.ts';
import { retirementReconciled } from './repo-instance-retirement.ts';
import { samsungSentState } from './repo-sync-targets.ts';
import { recordSyncLag } from './sync-lag.ts';
import type { WalletSyncRunResult } from './sync-operation-context.ts';
import { samsungOperationState } from './sync-samsung-state.ts';

/** What the card was told: the state recorded with its send targets, else (an operation from before) what the pass says now. */
async function samsungVoidOnly(ctx: ServiceContext, ref: WalletOperationRef): Promise<boolean> {
  const sent = await samsungSentState(ctx.env.DB, ref.instanceId, ref.version);
  if (sent) return sent === 'CANCELED';
  const op = await getWalletOperation(ctx.env.DB, ref);
  return op?.kind === 'revoke' && (await samsungOperationState(ctx, op)) === 'CANCELED';
}

/** Idempotent crash recovery: a Samsung tombstone must survive the eventual pass deletion. */
export async function finishWalletProviderRetirement(
  ctx: ServiceContext,
  ref: WalletOperationRef,
): Promise<boolean> {
  ctx = snapshotWalletCredentialContext(ctx);
  ref = { ...ref };
  const instance = await getWalletInstanceById(ctx.env.DB, ref);
  if (!instance || instance.desiredVersion !== ref.version) return false;
  if (instance.lifecycle === 'retired') return retirementReconciled(ctx.env.DB, ref);
  if (instance.lifecycle !== 'revoked') return false;
  // A previously disclosed Save JWT may be replayable after inactivation. The repository retires a
  // Google instance only once its revoke was read back inactive and barcode-less (0198), so
  // acceptance of the PUT alone never authorizes a hard purge.
  // A voided Samsung card was told CANCELED and stays served (Get Card Data still answers it, so an unvoid
  // can bring it back): only a deletion leaves a tombstone.
  if (instance.provider === 'samsung' && (await samsungVoidOnly(ctx, ref)))
    return retirementReconciled(ctx.env.DB, ref);
  if (
    instance.provider === 'samsung' &&
    !(await persistSamsungTombstone(ctx, {
      instanceId: ref.instanceId,
      orgId: ref.orgId,
      mode: ref.mode,
      operationVersion: ref.version,
    }))
  )
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
  if (state === 'succeeded') await recordSyncLag(ctx, op);
  if (state === 'succeeded' && op.kind === 'revoke') {
    await finishWalletProviderRetirement(ctx, claim);
  }
  return 'completed';
}
