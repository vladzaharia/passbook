import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseSteps } from './dto.ts';
import { sendOperationRun } from './jobs.ts';
import { progressOf } from './progress.ts';
import { kindOf, runnerOf } from './registry.ts';
import type { OperationRow } from './repo.ts';
import { bumpHeartbeat, markResent, runningSilentSince, waitingSilentSince } from './repo-sweep.ts';

/** Used when a kind is no longer declared. */
const DEFAULT_STALL_MS = 10 * 60_000;
/** No kind stalls sooner: the first query only reads rows silent this long. */
const MIN_STALL_MS = 60_000;
const BATCH = 100;
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

/** A waiting row with steps still to do, and nobody holding it: a wake-up was lost. Tail steps wait by design. */
function lostWakeUp(row: OperationRow, now: number): boolean {
  if (row.lease_until !== null && row.lease_until > now) return false;
  const tails = new Set(
    kindOf(row.kind)
      ?.steps.filter((s) => s.tail)
      .map((s) => s.key),
  );
  const steps = parseSteps(row.steps);
  // A step blocked until a time (Apple, a rate window) is a wait the operation is meant to sit in.
  if (steps.some((s) => s.state === 'waiting' && s.waitingReason === 'blocked')) return false;
  return steps.some((s) => s.state === 'pending' && !tails.has(s.key));
}

/**
 * The minute hook, over queued and running rows, and waiting rows that still have non-tail steps to do and no live
 * lease (a lost wake-up). A waiting row with only its tail left is exempt: a long wait is the point of it.
 */
export async function sweepStalledOperations(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const silent = [
    ...(await runningSilentSince(ctx.env.DB, now - MIN_STALL_MS, BATCH)),
    ...(await waitingSilentSince(ctx.env.DB, now - MIN_STALL_MS, BATCH)).filter((r) =>
      lostWakeUp(r, now),
    ),
  ];
  for (const row of silent) {
    const limit = kindOf(row.kind)?.stallMs ?? DEFAULT_STALL_MS;
    if ((row.heartbeat_at ?? row.created_at) > now - limit) continue;
    await check(ctx, row, now);
  }
}
