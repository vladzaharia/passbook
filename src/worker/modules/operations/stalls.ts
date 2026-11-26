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

/** True when a Workflow-backed row's instance is gone or dead. A live one is not a stall. */
async function workflowDead(ctx: ServiceContext, row: OperationRow): Promise<boolean> {
  const find = runnerOf(row.kind)?.workflow;
  if (!find || !row.workflow_instance_id) return false;
  try {
    const instance = await find(ctx, row.workflow_instance_id);
    return DEAD_WORKFLOW.has((await instance.status()).status);
  } catch {
    // The instance cannot be found: it is gone.
    return true;
  }
}

async function check(ctx: ServiceContext, row: OperationRow, now: number): Promise<void> {
  const db = ctx.env.DB;
  const fail = async () => {
    await progressOf(ctx, row.id, row.attempt).fail(stalled());
    ctx.log.warn('operations.stalled', {
      code: 'OPERATION_STALLED',
      operationId: row.id,
      kind: row.kind,
    });
  };
  if (row.workflow_instance_id && runnerOf(row.kind)?.workflow) {
    if (await workflowDead(ctx, row)) await fail();
    else await bumpHeartbeat(db, row.id, now);
    return;
  }
  // Lease-backed: a running row with an expired lease is resent once; stalled again, it fails.
  if ((row.lease_until ?? 1) > now) return;
  if (row.lease_until === 0 || !runnerOf(row.kind)?.run) {
    await fail();
    return;
  }
  if (await markResent(db, row.id, row.attempt, now))
    await sendOperationRun(ctx, row.id, row.attempt);
}

/** The minute hook. Waiting rows are exempt: a long wait is the point of them. */
export async function sweepStalledOperations(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  for (const row of await runningSilentSince(ctx.env.DB, now - MIN_STALL_MS, BATCH)) {
    const limit = kindOf(row.kind)?.stallMs ?? DEFAULT_STALL_MS;
    if ((row.heartbeat_at ?? 0) > now - limit) continue;
    await check(ctx, row, now);
  }
}
