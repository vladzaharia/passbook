import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listStaleGoogleClassInstances, markInstanceDirty } from './repo-google-reconcile.ts';

/** Classes brought up per run, and runs per publish; a backlog beyond both is left to pass edits. */
export const RECONCILE_BATCH = 25;
export const RECONCILE_MAX_RUNS = 200;
const CONTINUE_DELAY_SECONDS = 60;

/**
 * `wallet.google_reconcile`: a Google release was published, so classes its template's earlier releases
 * wrote follow it without waiting for a pass edit. One instance per class is marked dirty and the drain
 * runs its upsert, whose compile rewrites the class (once). Per org and mode, bounded, and idempotent.
 * A run continues after the last class it saw (`after`), so classes that cannot be written do not hold back
 * the ones behind them; a short page ends the walk, and `RECONCILE_MAX_RUNS` caps it.
 */
export async function handleGoogleReconcile(
  job: JobOf<'wallet.google_reconcile'>,
  ctx: ServiceContext,
): Promise<void> {
  const stale = await listStaleGoogleClassInstances(ctx.env.DB, job, RECONCILE_BATCH);
  for (const { instanceId } of stale) await markInstanceDirty(ctx.env.DB, instanceId);
  const last = stale.at(-1);
  if (stale.length < RECONCILE_BATCH || !last) return;
  const runs = (job.runs ?? 0) + 1;
  if (runs >= RECONCILE_MAX_RUNS) {
    ctx.log.warn('wallet.google_reconcile_capped', {
      code: 'WALLET_GOOGLE_RECONCILE_CAP',
      orgId: job.orgId,
    });
    return;
  }
  await ctx.env.JOBS.send(
    { ...job, after: last.classIdHash, runs },
    { delaySeconds: CONTINUE_DELAY_SECONDS },
  );
}
