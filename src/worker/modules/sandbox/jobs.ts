import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops-retention.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { getPlatformSettings } from '../settings/service.ts';
import {
  deleteBundlesByIds,
  deleteCapturedBefore,
  deleteTestBroadcastsBefore,
  expiredTestBundles,
  expiredTestPasses,
  stageExpiredTestPassRetirement,
} from './repo.ts';
import { expireStaleForwards } from './repo-forward.ts';

const DAY_MS = 86_400_000;
/**
 * Each pass costs about four D1 queries plus one R2 call: at most ~300 for passes, leaving room in
 * the daily hooks' shared budget. A backlog drains over several days.
 */
const PASS_BATCH = 25;
const MAX_PASS_ROUNDS = 3;
const ROW_BATCH = 500;
const MAX_ROW_ROUNDS = 10;
/** A broadcast takes its per-pass rows with it, so fewer per round. */
const BROADCAST_BATCH = 100;
const MAX_BROADCAST_ROUNDS = 5;

/**
 * Stage retirement only for still-eligible snapshots. Pending or uncertain provider work keeps the
 * pass and its objects until reconciliation completes. Held passes cannot starve later candidates.
 */
export async function purgeTestPasses(ctx: ServiceContext, before: number): Promise<number> {
  const credentialKeysetCommitment = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  let total = 0;
  let after: { createdAt: number; id: string } | undefined;
  for (let round = 0; round < MAX_PASS_ROUNDS; round++) {
    const passes = await expiredTestPasses(ctx.env.DB, before, PASS_BATCH, {
      after,
      actionableOnly: true,
    });
    for (const pass of passes) {
      if (pass.providerRetirementNeeded)
        await stageExpiredTestPassRetirement(
          ctx.env.DB,
          pass,
          before,
          ctx.clock.now(),
          credentialKeysetCommitment,
        );
      if (!pass.providerRetirementComplete) continue;
      const prepared = await prepareScanRetentionDelete(ctx.env, pass);
      const removed = await deletePassRows(ctx.env.DB, pass, prepared, credentialKeysetCommitment, {
        testBefore: before,
        lifecycleGeneration: pass.lifecycleGeneration,
      });
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
      if (removed.deleted) total += 1;
    }
    if (passes.length < PASS_BATCH) break;
    const last = passes[passes.length - 1];
    if (!last) throw new Error('Missing last pass in full batch');
    after = { createdAt: last.createdAt, id: last.id };
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

async function purgeTestBroadcasts(ctx: ServiceContext, before: number): Promise<number> {
  let total = 0;
  for (let round = 0; round < MAX_BROADCAST_ROUNDS; round++) {
    const n = await deleteTestBroadcastsBefore(ctx.env.DB, before, BROADCAST_BATCH);
    total += n;
    if (n < BROADCAST_BATCH) break;
  }
  return total;
}

/** Every minute: reservations past their lease (or unknown for a day) release their locks. */
export async function sweepSandboxForwards(ctx: ServiceContext): Promise<void> {
  await expireStaleForwards(ctx);
}

/** One purge step: a failure is logged with its name and never skips the steps after it. */
async function step(
  ctx: ServiceContext,
  name: string,
  run: () => Promise<number>,
): Promise<number> {
  try {
    return await run();
  } catch (error) {
    ctx.log.error('sandbox.purge_step_failed', { code: 'SANDBOX_PURGE_STEP', step: name, error });
    return 0;
  }
}

/**
 * Deletes test passes, test bundles, finished test broadcasts and captured emails older than
 * `sandbox.purgeDays`. Bounded: what a run leaves over is taken the next day.
 */
export async function dailySandbox(ctx: ServiceContext): Promise<void> {
  const { 'sandbox.purgeDays': days } = await getPlatformSettings(ctx);
  const before = ctx.clock.now() - days * DAY_MS;
  await step(ctx, 'expire', async () => {
    await expireStaleForwards(ctx);
    return 0;
  });
  const passes = await step(ctx, 'passes', () => purgeTestPasses(ctx, before));
  const bundles = await step(ctx, 'bundles', () => purgeTestBundles(ctx, before));
  const broadcasts = await step(ctx, 'broadcasts', () => purgeTestBroadcasts(ctx, before));
  const emails = await step(ctx, 'captured', () => purgeCaptured(ctx, before));
  ctx.log.info('sandbox.purge', { passes, bundles, broadcasts, emails, days });
}
