import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import { type BroadcastRow, casState, dueBroadcasts, sendingSince } from './repo.ts';
import { finishBroadcast } from './run.ts';

export interface BroadcastParams {
  broadcastId: string;
}

const DUE_BATCH = 20;

/** One instance per broadcast, so two cron ticks can never run it twice. */
export const instanceIdOf = (broadcastId: string) => `broadcast-${broadcastId}`;

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already.?exist|instance.*exists/i.test(error.message);
}

/**
 * Moves a scheduled broadcast to sending (compare-and-swap: one caller wins) and starts its
 * Workflow. If the Workflow cannot start, the broadcast goes back to scheduled for the next tick.
 */
export async function launchBroadcast(
  ctx: ServiceContext,
  row: Pick<BroadcastRow, 'id' | 'org_id'>,
): Promise<boolean> {
  const db = ctx.env.DB;
  if (!(await casState(db, row.id, ['scheduled'], 'sending', { startedAt: ctx.clock.now() })))
    return false;
  const instanceId = instanceIdOf(row.id);
  try {
    await startRun(
      db,
      {
        instanceId,
        kind: 'broadcast',
        orgId: row.org_id,
        targetId: row.id,
        now: ctx.clock.now(),
      },
      { ignoreDuplicate: true },
    );
    try {
      await ctx.env.BROADCAST.create({ id: instanceId, params: { broadcastId: row.id } });
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      // An earlier attempt created it. If that run already ended, nothing will finish this one.
      if (await instanceEnded(ctx, instanceId)) {
        await finishBroadcast(ctx, instanceId, row.id, 'BROADCAST_FAILED');
        return false;
      }
    }
    return true;
  } catch (error) {
    ctx.log.error('broadcast.start_failed', { broadcastId: row.id, code: 'WORKFLOW_START', error });
    await casState(db, row.id, ['sending'], 'scheduled');
    return false;
  }
}

const ENDED = ['complete', 'errored', 'terminated'];

/** True when the Workflow instance is gone or has ended. A lookup that fails counts as running. */
async function instanceEnded(ctx: ServiceContext, instanceId: string): Promise<boolean> {
  try {
    const status = await (await ctx.env.BROADCAST.get(instanceId)).status();
    return ENDED.includes(status.status);
  } catch (error) {
    if (error instanceof Error && /not.?found/i.test(error.message)) return true;
    ctx.log.warn('broadcast.status_unknown', { instanceId, code: 'WORKFLOW_STATUS', error });
    return false;
  }
}

/** Sending for this long without an end: the instance is checked, and a dead one fails the send. */
const STUCK_AFTER_MS = 5 * 60_000;

/** Minute cron: fails broadcasts whose Workflow ended without settling them. */
export async function failStuckBroadcasts(ctx: ServiceContext): Promise<void> {
  const stuck = await sendingSince(ctx.env.DB, ctx.clock.now() - STUCK_AFTER_MS, DUE_BATCH);
  for (const row of stuck) {
    const instanceId = instanceIdOf(row.id);
    if (!(await instanceEnded(ctx, instanceId))) continue;
    ctx.log.error('broadcast.stuck', { broadcastId: row.id, code: 'BROADCAST_STUCK' });
    await finishBroadcast(ctx, instanceId, row.id, 'BROADCAST_FAILED');
  }
}

/** Minute cron: starts every scheduled broadcast whose time has come. */
export async function startDueBroadcasts(ctx: ServiceContext): Promise<void> {
  const due = await dueBroadcasts(ctx.env.DB, ctx.clock.now(), DUE_BATCH);
  for (const row of due) {
    try {
      await launchBroadcast(ctx, row);
    } catch (error) {
      ctx.log.error('broadcast.launch_failed', {
        broadcastId: row.id,
        code: 'BROADCAST_LAUNCH',
        error,
      });
    }
  }
}
