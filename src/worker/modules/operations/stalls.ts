import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { sendOperationRun } from './jobs.ts';
import { progressOf } from './progress.ts';
import { kindOf, runnerOf } from './registry.ts';
import type { OperationRow } from './repo.ts';
import { bumpHeartbeat, markResent, runningSilentSince } from './repo-sweep.ts';

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
    else if (state === 'complete') await progress.succeed();
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

/** The minute hook, over queued and running rows. Waiting rows are exempt: a long wait is the point of them. */
export async function sweepStalledOperations(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const row of await runningSilentSince(ctx.env.DB, now - MIN_STALL_MS, BATCH)) {
    const limit = kindOf(row.kind)?.stallMs ?? DEFAULT_STALL_MS;
    if ((row.heartbeat_at ?? row.created_at) > now - limit) continue;
    await check(ctx, row, now);
  }
}
