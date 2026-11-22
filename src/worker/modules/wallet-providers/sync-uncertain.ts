import type { ServiceContext } from '../../platform/service-context.ts';
import { settleWalletClaim } from './instance.ts';
import { listUncertainGoogleOperations } from './repo-sync-uncertain.ts';

/**
 * An uncertain Google claim is not left wedged: both operations are idempotent against Google (the
 * upsert reads an existing object before it writes, the revoke reads before its PUT and confirms after),
 * so once the old attempt cannot still be running the operation goes back to retry and the drain runs it
 * again. Without this an uncertain upsert would block every later claim for the instance, the revoke
 * and so the pass's deletion.
 */
export async function sweepUncertainGoogleOperations(
  ctx: ServiceContext,
  limit: number,
): Promise<number> {
  let settled = 0;
  for (const op of await listUncertainGoogleOperations(ctx.env.DB, ctx.clock.now(), limit)) {
    if (await settleWalletClaim(ctx, { ...op, provider: 'google', now: ctx.clock.now() }))
      settled += 1;
  }
  if (settled > 0)
    ctx.log.info('wallet.google_uncertain_settled', { code: 'WALLET_GOOGLE_UNCERTAIN', settled });
  return settled;
}
