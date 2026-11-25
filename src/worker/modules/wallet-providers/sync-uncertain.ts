import type { ServiceContext } from '../../platform/service-context.ts';
import { settleWalletClaim } from './instance.ts';
import { listUncertainOperations } from './repo-sync-uncertain.ts';

/**
 * An uncertain claim is not left wedged. Google's operations are idempotent (the upsert reads an existing
 * object before it writes, the revoke reads before its PUT and confirms after); Samsung has no read, but its
 * Update Notification re-sends the same state to the same reference, so a repeat is harmless. Once the old
 * attempt cannot still be running the operation goes back to retry and the drain runs it again. Without this
 * an uncertain claim would block every later one for the instance, the revoke and so the pass's deletion.
 */
export async function sweepUncertainOperations(
  ctx: ServiceContext,
  limit: number,
): Promise<number> {
  const settled = { google: 0, samsung: 0 };
  for (const op of await listUncertainOperations(ctx.env.DB, ctx.clock.now(), limit))
    if (await settleWalletClaim(ctx, { ...op, now: ctx.clock.now() })) settled[op.provider] += 1;
  if (settled.google + settled.samsung > 0)
    ctx.log.info('wallet.uncertain_settled', { code: 'WALLET_UNCERTAIN_SETTLED', ...settled });
  return settled.google + settled.samsung;
}
