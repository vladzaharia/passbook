import type { DeveloperSandbox } from '../../../shared/contracts/developer.ts';
import type { OperationDto, OperationResult } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import type { Progress } from '../operations/progress-types.ts';
import { releaseLease, rowById } from '../operations/repo.ts';
import { deleteHalf, startPurge } from './delete.ts';
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
  await held(ctx, op, options.lease);
  const sandbox = await provisionSandbox(ctx, session, progress, {
    ...(options.viewedAt === undefined ? {} : { viewedAt: options.viewedAt }),
    ...(op.target ? { orgId: op.target.id } : {}),
    hooks: {
      after: async (step) => {
        await held(ctx, op, options.lease);
        await options.hooks?.after?.(step);
      },
    },
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
  const done = await resetSandbox(ctx, session, op, progress, async (step) => {
    await held(ctx, op, options.lease);
    await options.after?.(step);
  });
  await progress.succeed(result({ ...idsOf(done.sandbox), ...done.ids }));
}

const stepDone = (op: OperationDto, key: string) =>
  op.steps.find((s) => s.key === key)?.state === 'done';

/** A run that holds a lease checks it still does before each step's domain writes: a twin that took it over wins. */
async function held(ctx: ServiceContext, op: OperationDto, lease: string | undefined) {
  if (lease === undefined) return;
  const owner = (await rowById(ctx.env.DB, op.id))?.lease_owner;
  if (owner && owner !== lease)
    throw new AppError('OPERATION_LEASE_LOST', 409, 'Another runner took this over.');
}

/** The sandbox this operation is about: its target, set when it started. */
function targetOf(op: OperationDto): string {
  if (!op.target) throw new AppError('SANDBOX_NOT_FOUND', 404, 'Sandbox not found.');
  return op.target.id;
}

/**
 * Delete: close the sandbox and revoke its keys here, then the org purge Workflow takes over. It reports
 * `passes` and the `erase` wait, and ends the operation: this request has nothing left to wait for. The run is
 * pinned to the operation's own org: a newer sandbox of the person is never touched.
 */
export async function deleteRun(
  ctx: ServiceContext,
  by: Actor,
  op: OperationDto,
  progress: Progress,
): Promise<void> {
  const orgId = targetOf(op);
  await deleteHalf(ctx, by, progress, orgId);
  const instance =
    (await rowById(ctx.env.DB, op.id))?.workflow_instance_id ?? `${op.id}-r${op.attempt}`;
  if (await startPurge(ctx, op, orgId, instance, true)) return;
  // No purge Workflow on this Worker: nothing erases the data, so there is nothing to wait for.
  await progress.step('passes').skip();
  await progress.succeed(result({ orgId }));
}

/**
 * Start over: the delete's steps, then a new sandbox's. The old passes are voided before the new sandbox is
 * made (the new one is another org, so nothing waits on the 7 days). The run does not wait: it starts the purge and
 * hands the operation on, and the purge sends `operation.run` once the passes are voided. That second run finds
 * `close` and `passes` done, skips them and makes the new sandbox, through a reporter that reads the purge's steps fresh.
 */
export async function recreateRun(
  ctx: ServiceContext,
  session: SessionAuth,
  op: OperationDto,
  progress: Progress,
  options: RunOptions = {},
): Promise<void> {
  const orgId = targetOf(op);
  const by = { userId: session.userId, sessionIdHash: session.sessionId };
  await held(ctx, op, options.lease);
  // An earlier attempt closed it: whatever sandbox the person has now is the new half's, not the old one's.
  if (!stepDone(op, 'close')) await deleteHalf(ctx, by, progress, orgId);
  if (!stepDone(op, 'passes')) {
    if (await startPurge(ctx, op, orgId, `${op.id}-r${op.attempt}`, false)) {
      await releaseLease(ctx.env.DB, op.id, op.attempt, options.lease ?? null);
      return;
    }
    await progress.step('passes').skip();
  }
  await held(ctx, op, options.lease);
  const next = progressOf(ctx, op.id, op.attempt, options.lease);
  const sandbox = await provisionSandbox(ctx, session, next, {
    ...(options.viewedAt === undefined ? {} : { viewedAt: options.viewedAt }),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  await next.succeed(result(idsOf(sandbox)));
}
