import type { ServiceContext } from '../../platform/service-context.ts';
import type { WalletOperation } from './instance-types.ts';

/**
 * Q5: a provider update or a void reaches the wallet within 15 minutes at p95. Door denial does not wait for
 * it. Each settled operation logs how long it took from its queueing, and one over the target is a warning,
 * so the p95 is read from the logs and the tail is seen.
 */
export const WALLET_UPDATE_TARGET_MS = 15 * 60_000;

export function recordSyncLag(ctx: ServiceContext, op: WalletOperation): void {
  const lagMs = Math.max(0, ctx.clock.now() - op.createdAt);
  const fields = { provider: op.provider, kind: op.kind, lagMs, orgId: op.orgId };
  if (lagMs > WALLET_UPDATE_TARGET_MS)
    ctx.log.warn('wallet.sync_lag', { code: 'WALLET_SYNC_LAG_OVER', ...fields });
  else ctx.log.info('wallet.sync_lag', { code: 'WALLET_SYNC_LAG', ...fields });
}
