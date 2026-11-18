import { MERGE_ENGINE_REVISION } from '../../../passkit/template/merge/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertPending, requeue } from './fork-updates-offer.ts';
import { MAX_ATTEMPTS, RETRY_AFTER_MS, type UpdateKey } from './fork-updates-write.ts';
import { readForkState } from './repo-fork-update-checks.ts';
import { type Due, dueForks, retryableOffers } from './repo-fork-updates.ts';
import { effectiveBase } from './repo-forks.ts';
import { bakedAdoptionSnapshot } from './repo-sync.ts';
import { generatedSource, type SyncSource } from './sync.ts';
import { readAdoption } from './sync-adoption.ts';

async function enqueue(ctx: ServiceContext, u: UpdateKey): Promise<void> {
  await ctx.env.JOBS.send({
    kind: 'template.fork_update',
    updateId: u.id,
    templateId: u.templateId,
    orgId: u.orgId,
  });
}

/** The baked sync has settled this build's content, so the upstream versions read here are final. */
async function settled(ctx: ServiceContext, source: SyncSource): Promise<boolean> {
  const { value } = await bakedAdoptionSnapshot(ctx.env.DB);
  return readAdoption(value)?.hash === source.hash;
}

async function plan(ctx: ServiceContext, d: Due): Promise<void> {
  const base = await effectiveBase(ctx.env.DB, d.templateId, d.tip);
  const state = await readForkState(ctx.env.DB, d.templateId);
  const key = {
    orgId: d.orgId,
    templateId: d.templateId,
    upstreamId: d.upstreamId,
    upstreamVersion: d.upstreamVersion,
    oursVersion: d.tip,
  };
  const id = await insertPending(
    ctx,
    { ...key, baseVersion: base?.upstreamVersion ?? null },
    state,
    MERGE_ENGINE_REVISION,
  );
  if (id) await enqueue(ctx, { ...key, id });
}

/**
 * After the baked sync, offers each fork the upstream's active version: one pending row and one queue
 * job per fork. Rows that never finished are queued again. It never merges and never runs in the sync.
 */
export async function planForkUpdates(
  ctx: ServiceContext,
  source: SyncSource = generatedSource,
): Promise<void> {
  if (!(await settled(ctx, source))) return;
  const db = ctx.env.DB;
  for (const d of await dueForks(db)) {
    try {
      await plan(ctx, d);
    } catch (error) {
      ctx.log.error('templates.fork_plan_failed', {
        code: 'TEMPLATE_FORK_PLAN_FAILED',
        templateId: d.templateId,
        error,
      });
    }
  }
  const now = ctx.clock.now();
  const due = await retryableOffers(db, now - RETRY_AFTER_MS, MAX_ATTEMPTS);
  for (const u of due) {
    try {
      if (await requeue(ctx, u)) await enqueue(ctx, u);
    } catch (error) {
      ctx.log.error('templates.fork_plan_failed', {
        code: 'TEMPLATE_FORK_PLAN_FAILED',
        templateId: u.templateId,
        error,
      });
    }
  }
}
