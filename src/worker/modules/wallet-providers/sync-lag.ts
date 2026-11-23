import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletOperation } from './instance-types.ts';
import { passVersionCreatedAt, priorSucceededOperation } from './repo-instance-prior.ts';

/**
 * Q5: a provider update or a void reaches the wallet within 15 minutes at p95. Door denial does not wait for
 * it. Each settled operation logs how long it took, and one over the target is a warning, so the p95 is read
 * from the logs and the tail is seen.
 */
export const WALLET_UPDATE_TARGET_MS = 15 * 60_000;

/**
 * From the moment the pass changed, when this operation carries a change (a version newer than the one the
 * wallet last got): the queueing, the dirty-row waits and every retry are inside it. An operation with no
 * change of its own (a reissue, a boundary recompile) is measured from its queueing.
 */
async function since(ctx: ServiceContext, op: WalletOperation): Promise<number> {
  const prior = await priorSucceededOperation(ctx.env.DB, op.instanceId, op.version);
  if (prior !== null && op.passVersion <= prior.passVersion) return op.createdAt;
  const edit = await passVersionCreatedAt(ctx.env.DB, op.passId, op.passVersion);
  return Math.min(op.createdAt, edit ?? op.createdAt);
}

export async function recordSyncLag(ctx: ServiceContext, op: WalletOperation): Promise<void> {
  const lagMs = Math.max(0, ctx.clock.now() - (await since(ctx, op)));
  const fields = { provider: op.provider, kind: op.kind, lagMs, orgId: op.orgId };
  if (lagMs > WALLET_UPDATE_TARGET_MS)
    ctx.log.warn('wallet.sync_lag', { code: 'WALLET_SYNC_LAG_OVER', ...fields });
  else ctx.log.info('wallet.sync_lag', { code: 'WALLET_SYNC_LAG', ...fields });
}
