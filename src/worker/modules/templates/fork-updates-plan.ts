import { MERGE_ENGINE_REVISION } from '../../../passkit/template/merge/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { insertPending, requeue } from './fork-updates-offer.ts';
import { MAX_ATTEMPTS, RETRY_AFTER_MS, type UpdateKey } from './fork-updates-write.ts';
import { readForkState } from './repo-fork-update-checks.ts';
import { anyDue, type Due, dueForks, pendingOffers, retryableOffers } from './repo-fork-updates.ts';
import { effectiveBase } from './repo-forks.ts';
import { bakedAdoptionSnapshot } from './repo-sync.ts';
import { generatedSource, type SyncSource } from './sync.ts';
import { readAdoption } from './sync-adoption.ts';

async function enqueue(ctx: ServiceContext, offers: readonly UpdateKey[]): Promise<void> {
  if (offers.length === 0) return;
  await ctx.env.JOBS.sendBatch(
    offers.map((u) => ({
      body: {
        kind: 'template.fork_update' as const,
        updateId: u.id,
        templateId: u.templateId,
        orgId: u.orgId,
      },
    })),
  );
}

/** Offers waiting for their job beyond this many mean the queue is behind: plan nothing new. */
const MAX_PENDING = 40;

/**
 * The baked sync has settled this build's content, so the upstream versions read here are final.
 * Minute hooks run concurrently, so this check, not the hook order, is what orders planning after the sync.
 */
async function settled(ctx: ServiceContext, source: SyncSource): Promise<boolean> {
  const { value } = await bakedAdoptionSnapshot(ctx.env.DB);
  return readAdoption(value)?.hash === source.hash;
}

async function plan(ctx: ServiceContext, d: Due): Promise<UpdateKey | null> {
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
  return id ? { ...key, id } : null;
}

/**
 * After the baked sync, offers each fork the upstream's active version: one pending row and one queue
 * job per fork. Rows that never finished are queued again. It never merges and never runs in the sync.
 * The hook shares the minute invocation's D1 budget, so it is bounded: at most 20 new offers and 20
 * retries a tick (about 100 queries), a cheap check first when nothing can be due, and nothing at all
 * while the queue is behind.
 */
export async function planForkUpdates(
  ctx: ServiceContext,
  source: SyncSource = generatedSource,
): Promise<void> {
  if (!(await settled(ctx, source))) return;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  if ((await pendingOffers(db, now - RETRY_AFTER_MS)) >= MAX_PENDING) return;
  const queue: UpdateKey[] = [];
  const fail = (templateId: string, error: unknown) =>
    ctx.log.error('templates.fork_plan_failed', {
      code: 'TEMPLATE_FORK_PLAN_FAILED',
      templateId,
      error,
    });
  if (await anyDue(db))
    for (const d of await dueForks(db)) {
      try {
        const offer = await plan(ctx, d);
        if (offer) queue.push(offer);
      } catch (error) {
        fail(d.templateId, error);
      }
    }
  for (const u of await retryableOffers(db, now - RETRY_AFTER_MS, MAX_ATTEMPTS)) {
    try {
      if (await requeue(ctx, u)) queue.push(u);
    } catch (error) {
      fail(u.templateId, error);
    }
  }
  await enqueue(ctx, queue);
}
