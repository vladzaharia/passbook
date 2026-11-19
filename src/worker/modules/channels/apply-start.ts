import { jobGrant } from '../../platform/authority.ts';
import { inList, lt } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { failRun } from './apply-run.ts';
import { stalledPending } from './repo-runs.ts';

/** A pending run this long past its start time has no workflow behind it. */
const STALLED_AFTER_MS = 2 * 60_000;
const SWEEP_LIMIT = 50;

/** Instances a run may use: the first, then up to three replacements. */
const MAX_RECREATE = 3;
const DEAD = new Set(['errored', 'terminated', 'complete']);
export const RUN_LOST = 'CHANNEL_APPLY_RUN_LOST';

const instanceIdOf = (runId: string, n: number) => (n === 0 ? runId : `${runId}-r${n}`);

/** Starts a workflow instance for the run. One that already exists is fine: the id is fixed. */
export async function startApplyInstance(
  ctx: ServiceContext,
  runId: string,
  instanceId = runId,
): Promise<void> {
  try {
    await ctx.env.CHANNEL_APPLY.create({ id: instanceId, params: { runId } });
  } catch (error) {
    if (/already.?exist/i.test(error instanceof Error ? error.message : String(error))) {
      ctx.log.info('channels.apply.exists', { runId });
      return;
    }
    // The sweep starts it within a minute.
    ctx.log.error('channels.apply.create_failed', { runId, code: 'CHANNEL_APPLY_CREATE', error });
  }
}

/** Whether the instance is absent, alive (queued, waiting, running) or ended. */
async function instanceState(
  ctx: ServiceContext,
  instanceId: string,
): Promise<'missing' | 'live' | 'dead'> {
  let status: string;
  try {
    status = (await (await ctx.env.CHANNEL_APPLY.get(instanceId)).status()).status;
  } catch {
    return 'missing';
  }
  return DEAD.has(status) ? 'dead' : 'live';
}

/**
 * A pending run needs a live instance. A lost one (never created, errored, terminated, or ended without
 * the run) is replaced under a new id up to three times; then the run fails as lost.
 */
async function ensureInstance(ctx: ServiceContext, runId: string): Promise<void> {
  for (let n = 0; n <= MAX_RECREATE; n++) {
    const id = instanceIdOf(runId, n);
    const state = await instanceState(ctx, id);
    if (state === 'live') return;
    if (state === 'missing') {
      await startApplyInstance(ctx, runId, id);
      return;
    }
  }
  await failRun(ctx, runId, RUN_LOST);
}

/** Cron: gives each stalled pending run (one not waiting behind a running run) a live instance. */
export async function sweepChannelApply(ctx: ServiceContext): Promise<void> {
  const ids = await stalledPending(ctx.env.DB, ctx.clock.now() - STALLED_AFTER_MS, SWEEP_LIMIT);
  for (const id of ids) await ensureInstance(ctx, id);
}

/** Runs that ended this long ago are deleted, with their marks. */
const RUNS_KEPT_MS = 30 * 86_400_000;

/** Daily: drops finished runs past their retention. */
export async function dailyChannels(ctx: ServiceContext): Promise<void> {
  const g = jobGrant(ctx, {
    job: 'channel-apply-retention',
    purpose: 'platform.job.channels_apply_retention',
    tables: ['channel_apply_runs'],
  });
  g.delete('channel_apply_runs', {
    where: {
      state: inList(['done', 'dropped', 'failed']),
      finished_at: lt(ctx.clock.now() - RUNS_KEPT_MS),
    },
  });
  const [result] = await g.commit();
  ctx.log.info('channels.apply.retention', { deleted: result?.meta.changes ?? 0 });
}
