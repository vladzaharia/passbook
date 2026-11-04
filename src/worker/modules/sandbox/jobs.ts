import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops.ts';
import { getPlatformSettings } from '../settings/service.ts';
import {
  deleteBundlesByIds,
  deleteCapturedBefore,
  expiredTestBundles,
  expiredTestPasses,
} from './repo.ts';

const DAY_MS = 86_400_000;
/** Each pass costs about four D1 queries plus one R2 call; a run stays well inside 1,000. */
const PASS_BATCH = 25;
const MAX_PASS_ROUNDS = 8;
const ROW_BATCH = 500;
const MAX_ROW_ROUNDS = 10;

/** Hard-deletes expired test passes through the same row and object removal as pass retention. */
export async function purgeTestPasses(ctx: ServiceContext, before: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_PASS_ROUNDS; round++) {
    const passes = await expiredTestPasses(ctx.env.DB, before, PASS_BATCH);
    for (const pass of passes) {
      const removed = await deletePassRows(ctx.env.DB, pass);
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
    }
    total += passes.length;
    if (passes.length < PASS_BATCH) break;
  }
  return total;
}

async function purgeTestBundles(ctx: ServiceContext, before: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_ROW_ROUNDS; round++) {
    const bundles = await expiredTestBundles(ctx.env.DB, before, ROW_BATCH);
    total += await deleteBundlesByIds(
      ctx.env.DB,
      bundles.map((b) => b.id),
    );
    if (bundles.length < ROW_BATCH) break;
  }
  return total;
}

async function purgeCaptured(ctx: ServiceContext, before: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_ROW_ROUNDS; round++) {
    const n = await deleteCapturedBefore(ctx.env.DB, before, ROW_BATCH);
    total += n;
    if (n < ROW_BATCH) break;
  }
  return total;
}

/**
 * Deletes test passes, test bundles and captured emails older than `sandbox.purgeDays`. Bounded:
 * what a run leaves over is taken the next day.
 */
export async function dailySandbox(ctx: ServiceContext): Promise<void> {
  const { 'sandbox.purgeDays': days } = await getPlatformSettings(ctx);
  const before = ctx.clock.now() - days * DAY_MS;
  const passes = await purgeTestPasses(ctx, before);
  const bundles = await purgeTestBundles(ctx, before);
  const emails = await purgeCaptured(ctx, before);
  ctx.log.info('sandbox.purge', { passes, bundles, emails, days });
}
