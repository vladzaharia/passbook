import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseSteps } from './dto.ts';
import { sendOperationRun } from './jobs.ts';
import { kinds } from './kinds.ts';
import { progressOf } from './progress.ts';
import { kindOf, runnerOf } from './registry.ts';
import type { OperationRow } from './repo.ts';
import { bumpHeartbeat, markResent, runningSilentSince, waitingSilentSince } from './repo-sweep.ts';

/** Used when a kind is no longer declared. */
const DEFAULT_STALL_MS = 10 * 60_000;
/** No kind stalls sooner: the first query only reads rows silent this long. */
const MIN_STALL_MS = 60_000;
const BATCH = 100;
/** A timed wait is a lost wake-up this long after its end (the longest gap between looks is 15 min). */
const LOST_LOOK_GRACE_MS = 20 * 60_000;
const DEAD_WORKFLOW = new Set(['errored', 'terminated']);

const stalled = () => new AppError('OPERATION_STALLED', 500, 'The operation stopped responding.');

type WorkflowState = 'dead' | 'complete' | 'alive' | 'unknown';

/** Only a definite "not found" means the instance is gone; any other error leaves the row alone until the next sweep. */
const isNotFound = (error: unknown) =>
  error instanceof Error && /not[ _.]found/i.test(`${error.name} ${error.message}`);

async function workflowState(ctx: ServiceContext, row: OperationRow): Promise<WorkflowState> {
  const find = runnerOf(row.kind)?.workflow;
  if (!find || !row.workflow_instance_id) return 'unknown';
  try {
    const { status } = await (await find(ctx, row.workflow_instance_id)).status();
    if (status === 'complete') return 'complete';
    return DEAD_WORKFLOW.has(status) ? 'dead' : 'alive';
  } catch (error) {
    if (isNotFound(error)) return 'dead';
    ctx.log.warn('operations.stall_check_failed', {
      code: 'OPERATION_STALL_CHECK_FAILED',
      operationId: row.id,
      cause: error instanceof Error ? error.name : 'unknown',
    });
    return 'unknown';
  }
}

async function check(ctx: ServiceContext, row: OperationRow, now: number): Promise<void> {
  const db = ctx.env.DB;
  const progress = progressOf(ctx, row.id, row.attempt);
  const fail = async () => {
    await progress.fail(stalled());
    ctx.log.warn('operations.stalled', {
      code: 'OPERATION_STALLED',
      operationId: row.id,
      kind: row.kind,
    });
  };
  if (row.workflow_instance_id && runnerOf(row.kind)?.workflow) {
    const state = await workflowState(ctx, row);
    if (state === 'dead') await fail();
    // The instance finished but its final write was lost: settle the row.
    // `complete` only means run() returned: the outcome is not known, so it is not assumed to be success.
    else if (state === 'complete')
      await progress.fail(
        new AppError('OPERATION_OUTCOME_UNKNOWN', 500, 'The outcome was not recorded.'),
      );
    else if (state === 'alive') await bumpHeartbeat(db, row.id, now);
    return;
  }
  // Lease-backed or never started: a free or expired lease is resent once; stalled again, it fails.
  if (row.lease_until !== null && row.lease_until > now) return;
  if (row.resends >= 1 || !runnerOf(row.kind)?.run) {
    await fail();
    return;
  }
  if (await markResent(db, row.id, row.attempt, row.resends, now))
    await sendOperationRun(ctx, row.id, row.attempt);
}

/** Each kind's tail step keys: they wait after Done by design. */
function tailKeys(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const k of kinds.values()) {
    const keys = k.steps.filter((s) => s.tail).map((s) => s.key);
    if (keys.length) out.set(k.kind, keys);
  }
  return out;
}

/**
 * The one rule for a row that may have lost its wake-up. A timed wait that has not ended is planned, whatever is
 * pending behind it (a lost phone's mail). One that ended is silent from its end, and a lost wake-up once the look
 * that should have ended it is `LOST_LOOK_GRACE_MS` late. Without a timed wait, the row is lost once its heartbeat is
 * `limit` old. Tail steps wait by design and never count.
 */
export function lostWakeUp(
  row: OperationRow,
  steps: readonly { key: string; tail?: boolean }[] | undefined,
  now: number,
  limit: number,
): boolean {
  const tails = new Set(steps?.filter((x) => x.tail).map((x) => x.key));
  const timed = parseSteps(row.steps).filter(
    (x) => x.state === 'waiting' && !tails.has(x.key) && x.until !== null,
  );
  const heartbeatLimit = (row.heartbeat_at ?? row.created_at) + limit;
  if (row.status !== 'waiting' || !timed.length) return heartbeatLimit <= now;
  const ends = timed.map((x) => x.until ?? 0);
  if (ends.some((end) => end > now)) return false;
  return Math.max(...ends) + LOST_LOOK_GRACE_MS <= now && heartbeatLimit <= now;
}

/**
 * The minute hook, over queued and running rows, and waiting rows that still have non-tail steps to do and no live
 * lease (a lost wake-up). A waiting row with only its tail left is exempt: a long wait is the point of it.
 */
export async function sweepStalledOperations(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const silent = [
    ...(await runningSilentSince(ctx.env.DB, now - MIN_STALL_MS, BATCH)),
    ...(await waitingSilentSince(ctx.env.DB, {
      before: now - MIN_STALL_MS,
      now,
      limit: BATCH,
      staleBefore: now - MIN_STALL_MS,
      tails: tailKeys(),
    })),
  ];
  for (const row of silent) {
    const def = kindOf(row.kind);
    const limit = def?.stallMs ?? DEFAULT_STALL_MS;
    if (!lostWakeUp(row, def?.steps, now, limit)) continue;
    await check(ctx, row, now);
  }
}
