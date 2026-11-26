import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isActive, toDto } from './dto.ts';
import { progressOf } from './progress.ts';
import { runnerOf } from './registry.ts';
import { claimLease, rowById } from './repo.ts';
import { LEASE_MS } from './start.ts';

/** A resend comes this long after the start: past the lease, so a request that died is picked up. */
const BACKSTOP_SECONDS = LEASE_MS / 1000 + 30;

/** Queues `operation.run`: the delayed backstop of an in-request run, a retry's relaunch, a stall resend. */
export async function sendOperationRun(
  ctx: ServiceContext,
  operationId: string,
  attempt: number,
  delaySeconds?: number,
): Promise<void> {
  await ctx.env.JOBS.send(
    { kind: 'operation.run', operationId, attempt },
    delaySeconds === undefined ? undefined : { delaySeconds },
  );
}

/**
 * Work that should start at once, in the request. The operation was started with `lease: true`; the work
 * runs in `waitUntil`, and a delayed `operation.run` resumes it if the request died. The work is
 * idempotent ("complete what is missing"), so a resume after a partial run is safe.
 */
export async function runInRequest(
  ctx: ServiceContext,
  operationId: string,
  attempt: number,
  work: () => Promise<void>,
): Promise<void> {
  await sendOperationRun(ctx, operationId, attempt, BACKSTOP_SECONDS);
  ctx.waitUntil(work().catch((error) => progressOf(ctx, operationId, attempt).fail(error)));
}

/** Runs the kind's hook unless the operation ended, a newer attempt took over, or a runner holds the lease. */
export async function handleOperationRun(
  job: JobOf<'operation.run'>,
  ctx: ServiceContext,
): Promise<void> {
  const row = await rowById(ctx.env.DB, job.operationId);
  if (!row || !isActive(row.status) || row.attempt !== job.attempt) return;
  const run = runnerOf(row.kind)?.run;
  if (!run) {
    await progressOf(ctx, row.id, row.attempt).fail(new Error('No runner for this kind.'));
    return;
  }
  const now = ctx.clock.now();
  const lease = ctx.ids.id();
  if (!(await claimLease(ctx.env.DB, row.id, row.attempt, now, now + LEASE_MS, lease))) return;
  try {
    await run(ctx, toDto(row), lease);
  } catch (error) {
    await progressOf(ctx, row.id, row.attempt, lease).fail(error);
  }
}
