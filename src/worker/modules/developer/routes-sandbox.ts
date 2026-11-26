import {
  CreateDeveloperSandboxSchema,
  ResetDeveloperSandboxSchema,
  SandboxKeyResponseSchema,
} from '../../../shared/contracts/index.ts';
import { StartedOperationSchema } from '../../../shared/contracts/operations.ts';
import { SANDBOX_EXISTS_COPY } from '../../../shared/copy/developer.ts';
import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { ConflictError, ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { idempotencyKeyHeader } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { checkDelete, purgeInstanceId } from './delete.ts';
import { sandboxOfUser } from './repo.ts';
import { checkReset } from './reset.ts';
import { mintSandboxKeyOnce } from './sandbox-key.ts';
import { createRun, deleteRun, recreateRun, resetRun } from './sandbox-runs.ts';
import { startSandboxOp } from './sandbox-start.ts';

/** A signed-in developer who proved themselves recently: the sandbox's destructive calls. */
export const STEP_UP_AUTH = {
  human: true,
  signIn: 'strict',
  developer: true,
  stepUp: { maxAgeSec: STEP_UP_SECONDS },
} as const;

/** The Turnstile check every sandbox start makes; a failure is a 403 the page shows. */
async function requireHuman(
  c: Parameters<typeof clientIp>[0],
  ctx: ReturnType<typeof serviceContext>,
  token: string,
): Promise<void> {
  if (await verifyTurnstile(c.env, token, clientIp(c), ctx.log, fetch, TURNSTILE_SANDBOX_ACTION))
    return;
  ctx.log.warn('developer.turnstile_failed', { code: 'TURNSTILE_FAILED' });
  throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
}

/** The sandbox calls that start an operation, and the one that mints its key. */
export const developerSandboxRoutes = createRouter();

register(
  developerSandboxRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox',
    summary:
      'Make your developer sandbox: a test organization whose passes are previews. Answers 202 with an operation (`sandbox.create`); the key is minted once afterwards with `POST /developer/sandbox/key`.',
    operationId: 'developer.postSandbox',
    auth: { human: true, signIn: 'strict', developer: true },
    body: CreateDeveloperSandboxSchema,
    status: 202,
    response: StartedOperationSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${auth.userId}`);
    const input = c.req.valid('json');
    await requireHuman(c, ctx, input.turnstileToken);
    const row = await sandboxOfUser(ctx.env.DB, auth.userId);
    // A closed sandbox is not remade; the person deletes it first to start over.
    if (row?.closed_at != null) throw new ConflictError(SANDBOX_EXISTS_COPY, 'SANDBOX_EXISTS');
    const operation = await startSandboxOp(ctx, auth, {
      kind: 'sandbox.create',
      orgId: row?.org_id ?? ctx.ids.id(),
      idempotencyKey: idempotencyKeyHeader(c.req.header('idempotency-key')),
      work: (op, progress) => createRun(ctx, auth, op, progress, { viewedAt: input.viewedAt }),
    });
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

register(
  developerSandboxRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/key',
    summary:
      'Mint your sandbox key, once. A second call answers 409 `SANDBOX_KEY_SHOWN` while the key is live: roll it instead.',
    operationId: 'developer.postSandboxKey',
    auth: { human: true, signIn: 'strict', developer: true },
    status: 201,
    response: SandboxKeyResponseSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox-key:${auth.userId}`);
    c.header('cache-control', 'no-store');
    return c.json({ key: await mintSandboxKeyOnce(serviceContext(c), auth) }, 201);
  },
);

register(
  developerSandboxRoutes,
  'developer',
  {
    method: 'delete',
    path: '/sandbox',
    summary:
      'Delete your developer sandbox, open or closed: keys, passes, webhooks, logs and templates go, and you can make a new one. Three a day. Answers 202 with an operation (`sandbox.delete`).',
    operationId: 'developer.deleteSandbox',
    auth: STEP_UP_AUTH,
    status: 202,
    response: StartedOperationSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const row = await checkDelete(ctx, auth);
    const operation = await startSandboxOp(ctx, auth, {
      kind: 'sandbox.delete',
      orgId: row.org_id,
      idempotencyKey: idempotencyKeyHeader(c.req.header('idempotency-key')),
      workflowInstanceId: await purgeInstanceId(
        ctx,
        { id: '', attempt: 1 },
        row.org_id,
        ctx.clock.now(),
      ),
      work: (op, progress) =>
        deleteRun(ctx, { userId: auth.userId, sessionIdHash: auth.sessionId }, op, progress),
    });
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

register(
  developerSandboxRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/recreate',
    summary:
      'Start over from nothing: delete your sandbox and make a new one. Counts as a delete. Answers 202 with an operation (`sandbox.recreate`); the key is minted once afterwards.',
    operationId: 'developer.postSandboxRecreate',
    auth: STEP_UP_AUTH,
    body: CreateDeveloperSandboxSchema,
    status: 202,
    response: StartedOperationSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${auth.userId}`);
    const input = c.req.valid('json');
    await requireHuman(c, ctx, input.turnstileToken);
    // With no sandbox there is nothing to delete: starting over is making one.
    const row = (await sandboxOfUser(ctx.env.DB, auth.userId))
      ? await checkDelete(ctx, auth)
      : null;
    const options = { viewedAt: input.viewedAt };
    const operation = await startSandboxOp(ctx, auth, {
      kind: row ? 'sandbox.recreate' : 'sandbox.create',
      orgId: row?.org_id ?? ctx.ids.id(),
      idempotencyKey: idempotencyKeyHeader(c.req.header('idempotency-key')),
      work: (op, progress) => (row ? recreateRun : createRun)(ctx, auth, op, progress, options),
    });
    c.header('location', `/api/v1/operations/${operation.id}`);
    return c.json({ operation }, 202);
  },
);

register(
  developerSandboxRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/reset',
    summary:
      'Start over: delete your sandbox test passes, captured webhooks and request log, restart the quickstart and revoke the key. Answers 202 with an operation (`sandbox.reset`); the key is minted once afterwards.',
    operationId: 'developer.postSandboxReset',
    auth: STEP_UP_AUTH,
    body: ResetDeveloperSandboxSchema,
    status: 202,
    response: StartedOperationSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(
      c.env,
      'RL_REFRESH',
      `RL_REFRESH:developer-sandbox-reset:${auth.userId}`,
    );
    await requireHuman(c, ctx, c.req.valid('json').turnstileToken);
    const row = await checkReset(ctx, auth);
    const operation = await startSandboxOp(ctx, auth, {
      kind: 'sandbox.reset',
      orgId: row.org_id,
      idempotencyKey: idempotencyKeyHeader(c.req.header('idempotency-key')),
      work: (op, progress) => resetRun(ctx, auth, op, progress),
    });
    c.header('location', `/api/v1/operations/${operation.id}`);
    c.header('cache-control', 'no-store');
    return c.json({ operation }, 202);
  },
);
