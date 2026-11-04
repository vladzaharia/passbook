import type { ServiceContext } from '../../platform/service-context.ts';
import { startRun } from '../../platform/workflow-runs.ts';
import { type BroadcastRow, casState, dueBroadcasts } from './repo.ts';

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
    }
    return true;
  } catch (error) {
    ctx.log.error('broadcast.start_failed', { broadcastId: row.id, code: 'WORKFLOW_START', error });
    await casState(db, row.id, ['sending'], 'scheduled');
    return false;
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
