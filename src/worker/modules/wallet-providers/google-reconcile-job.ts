import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { listStaleGoogleClassInstances, markInstanceDirty } from './repo-google-reconcile.ts';

/** Classes brought up per run; a larger backlog continues in a later run. */
const BATCH = 25;
const CONTINUE_DELAY_SECONDS = 60;

/**
 * `wallet.google_reconcile`: a Google release was published, so classes its template's earlier releases
 * wrote follow it without waiting for a pass edit. One instance per class is marked dirty and the drain
 * runs its upsert, whose compile rewrites the class (once). Per org and mode, bounded, and idempotent:
 * a class the release has written no longer matches, so a repeat finds only what is left.
 */
export async function handleGoogleReconcile(
  job: JobOf<'wallet.google_reconcile'>,
  ctx: ServiceContext,
): Promise<void> {
  const stale = await listStaleGoogleClassInstances(ctx.env.DB, job, BATCH);
  for (const { instanceId } of stale) await markInstanceDirty(ctx.env.DB, instanceId);
  // Marked classes stay in the list until the drain has written them, so continue only after a pause.
  if (stale.length === BATCH)
    await ctx.env.JOBS.send(job, { delaySeconds: CONTINUE_DELAY_SECONDS });
}
