import type { OperationDto } from '../../../shared/contracts/operations.ts';
import { isStrongAmr } from '../../../shared/sign-in.ts';
import { hasDeveloperAccess } from '../../../shared/spaces.ts';
import type { AuthContext, SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveSessionByHash } from '../auth/sessions.ts';
import { progressOf } from '../operations/progress.ts';
import type { OperationRunner, OperationRunners } from '../operations/registry.ts';
import { rowById } from '../operations/repo.ts';
import { checkDelete, deleteHalf, startPurge } from './delete.ts';
import { checkReset } from './reset.ts';
import { createRun, type RunOptions, recreateRun, resetRun } from './sandbox-runs.ts';

const DEAD = new Set(['errored', 'terminated', 'complete']);

const ended = () =>
  new AppError('SANDBOX_SESSION_ENDED', 401, 'Your sign-in ended. Sign in and try again.');

/** The person's session for a run that has no request: the one that started it, if it still lives. */
async function sessionOf(ctx: ServiceContext, opId: string): Promise<SessionAuth> {
  const hash = (await rowById(ctx.env.DB, opId))?.actor_session;
  const session = hash ? await resolveSessionByHash(ctx.env, ctx.clock, hash) : null;
  if (!session) throw ended();
  // The start asked for developer access: a person taken out of the group finishes nothing.
  if (!hasDeveloperAccess(session.roles))
    throw new ForbiddenError('Developer access is required.', 'DEVELOPER_ACCESS_REQUIRED');
  return session;
}

type Work = (
  ctx: ServiceContext,
  session: SessionAuth,
  op: OperationDto,
  progress: ReturnType<typeof progressOf>,
  options: RunOptions,
) => Promise<void>;

/** A resumed run (the backstop job, a retry): the person's own session, and the lease token on every write. */
const resumed =
  (work: Work): NonNullable<OperationRunner['run']> =>
  async (ctx, op, lease) =>
    work(ctx, await sessionOf(ctx, op.id), op, progressOf(ctx, op.id, op.attempt, lease), {
      lease,
    });

const stepDone = (op: OperationDto, key: string) =>
  op.steps.find((s) => s.key === key)?.state === 'done';

const sessionOnly = (caller: AuthContext): SessionAuth => {
  if (caller.kind !== 'session') throw new ForbiddenError();
  return caller;
};

/** A retry runs the start's own checks again: the rate limit, and the day's slot unless an attempt already took it. */
const retryRules =
  (first: string, check?: (ctx: ServiceContext, session: SessionAuth) => Promise<unknown>) =>
  async (ctx: ServiceContext, op: OperationDto, caller: AuthContext) => {
    const session = sessionOnly(caller);
    // As the start route: a developer, signed in strongly.
    if (!hasDeveloperAccess(session.roles) || !isStrongAmr(session.amr))
      throw new ForbiddenError('Developer access is required.', 'DEVELOPER_ACCESS_REQUIRED');
    await enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${session.userId}`);
    if (check && !stepDone(op, first)) await check(ctx, session);
  };

/** A delete whose first half already ran has no sandbox left to check: the retry goes on to the purge. */
const deleteCheck = async (ctx: ServiceContext, session: SessionAuth) => {
  try {
    await checkDelete(ctx, session);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
};

/** The purge Workflow's handle, for the stall sweep. */
const workflow: NonNullable<OperationRunner['workflow']> = async (ctx, instanceId) => {
  if (!ctx.env.ORG_PURGE) throw new Error('not found');
  return ctx.env.ORG_PURGE.get(instanceId);
};

/** A delete relaunches the purge as its own instance, `<opId>-r<attempt>`, after the sandbox half is done again. */
const relaunchDelete: NonNullable<OperationRunner['relaunch']> = async (ctx, op, previous) => {
  const row = await rowById(ctx.env.DB, op.id);
  const old = previous.instanceId;
  if (old && typeof ctx.env.ORG_PURGE?.get === 'function') {
    // Only a definite "gone" or a finished instance lets a second one start; a status that cannot be read is alive.
    const state = await ctx.env.ORG_PURGE.get(old)
      .then((i) => i.status())
      .catch((error: unknown) =>
        error instanceof Error && /not[ _.]found/i.test(`${error.name} ${error.message}`)
          ? { status: 'errored' }
          : { status: 'unknown' },
      );
    if (!DEAD.has(state.status))
      throw new ConflictError('The cleanup is still running.', 'OPERATION_RUNNING');
  }
  const by = { userId: op.startedBy.id ?? '', sessionIdHash: row?.actor_session ?? '' };
  const progress = progressOf(ctx, op.id, op.attempt);
  const orgId = op.target?.id;
  if (!orgId) throw new AppError('SANDBOX_NOT_FOUND', 404, 'Sandbox not found.');
  await deleteHalf(ctx, by, progress, orgId);
  const instanceId = `${op.id}-r${op.attempt}`;
  if (await startPurge(ctx, op, orgId, instanceId, true)) return { workflowInstanceId: instanceId };
  await progress.step('passes').skip();
  await progress.succeed({ href: null, ids: { orgId } });
  return undefined;
};

export const operationRunners: OperationRunners = {
  'sandbox.create': {
    run: resumed(createRun),
    authorizeRetry: retryRules('org'),
  },
  'sandbox.reset': {
    run: resumed(resetRun),
    authorizeRetry: retryRules('claim', checkReset),
  },
  'sandbox.recreate': {
    run: resumed(recreateRun),
    authorizeRetry: retryRules('close', deleteCheck),
  },
  'sandbox.delete': {
    // A delete is its Workflow's once the sandbox is closed, and a stall is found through that instance: no
    // lease and no `operation.run`, so a retry (`relaunch`) is the only way to run it again.
    authorizeRetry: retryRules('close', deleteCheck),
    relaunch: relaunchDelete,
    workflow,
  },
};
