import type { ServiceContext } from '../../platform/service-context.ts';
import type { DeferredStarter } from './repo-bulk-principal.ts';
import { type BulkRunRecord, type BulkRunState, releaseLock, saveRun } from './repo-bulk-runs.ts';
import type { Actor } from './service.ts';

/** Ids per R2 page. */
export const PAGE = 500;

export const pageKey = (r: Pick<BulkRunRecord, 'orgId' | 'id'>, n: number) =>
  `bulk-runs/${r.orgId}/${r.id}/${n}.json`;

export const actorOf = (s: DeferredStarter): Actor =>
  s.kind === 'membership' ? { type: 'user', id: s.userId } : { type: 'api_key', id: s.keyId };

export async function dropPages(ctx: ServiceContext, rec: BulkRunRecord): Promise<void> {
  for (let n = 0; n * PAGE < rec.total; n++) await ctx.env.BUCKET.delete(pageKey(rec, n));
}

export async function finish(
  ctx: ServiceContext,
  rec: BulkRunRecord,
  state: Exclude<BulkRunState, 'queued' | 'running'>,
  code: string | null,
): Promise<void> {
  const now = ctx.clock.now();
  const ended = { ...rec, state, code, finishedAt: now, updatedAt: now };
  // The write only lands while the run is still active, so a swept run is not revived.
  if (await saveRun(ctx.env.DB, ended)) {
    await releaseLock(ctx.env.DB, rec.orgId, rec.mode, rec.id);
    await dropPages(ctx, rec);
    ctx.log.info('passes.bulk_run_ended', {
      orgId: rec.orgId,
      runId: rec.id,
      state,
      done: rec.done,
      skipped: rec.skipped,
      ...(code ? { code } : {}),
    });
  }
}
