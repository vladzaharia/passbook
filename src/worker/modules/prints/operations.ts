import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { releaseLease } from '../operations/repo.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { readStoredBulk, writeBulkStatus } from './bulk-status.ts';

type Caller = Parameters<NonNullable<OperationRunner['authorizeRetry']>>[2];

/** As the routes: a job belongs to the user that started it, or to the org of the key that did. */
const callerIdOf = (caller: Caller): string => {
  if (caller.kind === 'session') return caller.userId;
  if (caller.kind === 'api_key') return caller.orgId ?? caller.keyId;
  throw new ForbiddenError();
};

const jobOf = (op: { orgId: string | null; target: { type: string; id: string } | null }) => {
  if (!op.orgId || op.target?.type !== 'print-job')
    throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
  return { orgId: op.orgId, jobId: op.target.id };
};

/** A retry is the starter's own: passes:operate in the org, and the job is the caller's. */
const authorizeRetry: NonNullable<OperationRunner['authorizeRetry']> = async (ctx, op, caller) => {
  const { orgId, jobId } = jobOf(op);
  await tenantAuthorityOf(ctx, caller, orgId, 'passes:operate');
  const stored = await readStoredBulk(ctx.env.BUCKET, orgId, jobId);
  if (!stored) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
  if (stored.userId !== callerIdOf(caller) || stored.mode !== modeOf(caller))
    throw new ForbiddenError();
};

/**
 * Renders again: the job goes back to pending and its message is sent. The lease `operation.run` took is let
 * go first, because the job writes without one. The prints already exist, so nothing is minted twice.
 */
const run: NonNullable<OperationRunner['run']> = async (ctx, op, lease) => {
  const { orgId, jobId } = jobOf(op);
  await releaseLease(ctx.env.DB, op.id, op.attempt, lease);
  const stored = await readStoredBulk(ctx.env.BUCKET, orgId, jobId);
  if (!stored) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
  if (stored.state !== 'ready')
    await writeBulkStatus(ctx.env.BUCKET, orgId, jobId, {
      ...stored,
      state: 'pending',
      at: ctx.clock.now(),
    });
  await ctx.env.JOBS.send({
    kind: 'prints.bulk',
    orgId,
    jobId,
    passIds: stored.passIds,
    operationId: op.id,
    attempt: op.attempt,
  });
};

export const operationRunners: OperationRunners = { 'prints.bulk': { run, authorizeRetry } };
