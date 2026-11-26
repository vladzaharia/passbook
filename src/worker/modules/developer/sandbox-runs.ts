import type { DeveloperSandbox } from '../../../shared/contracts/developer.ts';
import type { OperationDto, OperationResult } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isActive, parseSteps } from '../operations/dto.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { rowById } from '../operations/repo.ts';
import { deleteHalf, purgeInstanceId, startPurge } from './delete.ts';
import { resetSandbox } from './reset.ts';
import { provisionSandbox, type SandboxHooks } from './service.ts';

/** The person a delete acts for: the id and the session that started it. */
export interface Actor {
  userId: string;
  sessionIdHash: string;
}

export interface RunOptions {
  /** The runner's lease token (a resumed run): its writes carry it. */
  lease?: string;
  /** When the person's browser first opened the quickstart; known only to the request that started it. */
  viewedAt?: number;
  /** Tests: stop after a step, as a fault would. */
  hooks?: SandboxHooks;
  after?: (step: string) => Promise<void>;
  /** How often a start over looks for the purge to reach its wait. */
  pollMs?: number;
}

/** Ids only: the page reads the sandbox from them, and no secret fits. */
function idsOf(sandbox: DeveloperSandbox): Record<string, string> {
  return {
    sandboxId: sandbox.id,
    orgId: sandbox.orgId,
    orgSlug: sandbox.orgSlug,
    ...(sandbox.templateId ? { templateId: sandbox.templateId } : {}),
  };
}

const result = (ids: Record<string, string>): OperationResult => ({ href: null, ids });

export async function createRun(
  ctx: ServiceContext,
  session: SessionAuth,
  op: OperationDto,
  progress: Progress,
  options: RunOptions = {},
): Promise<void> {
  const sandbox = await provisionSandbox(ctx, session, progress, {
    ...(options.viewedAt === undefined ? {} : { viewedAt: options.viewedAt }),
    ...(op.target ? { orgId: op.target.id } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  await progress.succeed(result(idsOf(sandbox)));
}

export async function resetRun(
  ctx: ServiceContext,
  session: SessionAuth,
  op: OperationDto,
  progress: Progress,
  options: RunOptions = {},
): Promise<void> {
  const done = await resetSandbox(ctx, session, op, progress, options.after);
  await progress.succeed(result({ ...idsOf(done.sandbox), ...done.ids }));
}

/** The purge Workflow's instance: the one the operation was started with, else this attempt's. */
async function instanceOf(ctx: ServiceContext, op: OperationDto, orgId: string): Promise<string> {
  return (
    (await rowById(ctx.env.DB, op.id))?.workflow_instance_id ??
    (await purgeInstanceId(ctx, op, orgId, ctx.clock.now()))
  );
}

/**
 * Delete: close the sandbox and revoke its keys here, then the org purge Workflow takes over. It reports
 * `passes` and the `erase` wait, and ends the operation: this request has nothing left to wait for.
 */
export async function deleteRun(
  ctx: ServiceContext,
  by: Actor,
  op: OperationDto,
  progress: Progress,
): Promise<void> {
  const orgId = (await deleteHalf(ctx, by, progress)) ?? op.target?.id;
  if (!orgId) throw new AppError('SANDBOX_NOT_FOUND', 404, 'Sandbox not found.');
  if (await startPurge(ctx, op, orgId, await instanceOf(ctx, op, orgId), true)) return;
  // No purge Workflow on this Worker: nothing erases the data, so there is nothing to wait for.
  await progress.step('passes').skip();
  await progress.succeed(result({ orgId }));
}

const MAX_WAIT_MS = 25 * 60_000;

/** True once the purge reaches its wait (the passes are voided), false when the operation ended meanwhile. */
async function purgeReachedWait(ctx: ServiceContext, opId: string, pollMs: number) {
  const until = Date.now() + MAX_WAIT_MS;
  while (Date.now() < until) {
    const row = await rowById(ctx.env.DB, opId);
    if (!row || !isActive(row.status)) return false;
    const erase = parseSteps(row.steps).find((s) => s.key === 'erase');
    if (erase && (erase.state === 'waiting' || erase.state === 'done')) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new AppError('OPERATION_STALLED', 500, 'The operation stopped responding.');
}

/**
 * Start over: the delete's steps, then a new sandbox's. The old passes are voided before the new sandbox is
 * made (the new one is another org, so nothing waits on the 7 days). The purge writes the old steps, so the new
 * part reports through a reporter that reads them fresh.
 */
export async function recreateRun(
  ctx: ServiceContext,
  session: SessionAuth,
  op: OperationDto,
  progress: Progress,
  options: RunOptions = {},
): Promise<void> {
  const by = { userId: session.userId, sessionIdHash: session.sessionId };
  const orgId = (await deleteHalf(ctx, by, progress)) ?? op.target?.id;
  const voided = op.steps.find((s) => s.key === 'passes')?.state === 'done';
  if (orgId && !voided) {
    if (await startPurge(ctx, op, orgId, await instanceOf(ctx, op, orgId), false, options.lease)) {
      if (!(await purgeReachedWait(ctx, op.id, options.pollMs ?? 1500))) return;
    } else await progress.step('passes').skip();
  }
  const next = progressOf(ctx, op.id, op.attempt, options.lease);
  const sandbox = await provisionSandbox(ctx, session, next, {
    ...(options.viewedAt === undefined ? {} : { viewedAt: options.viewedAt }),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  await next.succeed(result(idsOf(sandbox)));
}
