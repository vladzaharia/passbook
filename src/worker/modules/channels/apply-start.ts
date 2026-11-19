import { jobGrant } from '../../platform/authority.ts';
import { inList, lt } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { stalledPending } from './repo-runs.ts';

/** A pending run this long past its start time has no workflow behind it. */
const STALLED_AFTER_MS = 2 * 60_000;
const SWEEP_LIMIT = 50;

/** Starts the run's workflow instance. An instance that already exists is fine: the id is the run's. */
export async function startApplyInstance(ctx: ServiceContext, runId: string): Promise<void> {
  try {
    await ctx.env.CHANNEL_APPLY.create({ id: runId, params: { runId } });
  } catch (error) {
    if (/already.?exist/i.test(error instanceof Error ? error.message : String(error))) {
      ctx.log.info('channels.apply.exists', { runId });
      return;
    }
    // The sweep starts it within a minute.
    ctx.log.error('channels.apply.create_failed', { runId, code: 'CHANNEL_APPLY_CREATE', error });
  }
}

/** Cron: starts an instance for each pending run whose save never reached one. */
export async function sweepChannelApply(ctx: ServiceContext): Promise<void> {
  const ids = await stalledPending(ctx.env.DB, ctx.clock.now() - STALLED_AFTER_MS, SWEEP_LIMIT);
  for (const id of ids) await startApplyInstance(ctx, id);
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
