import { z } from 'zod';
import { DeveloperHomeSchema } from '../../../shared/contracts/developer-home.ts';
import {
  CreateDeveloperSandboxSchema,
  CreatedDeveloperSandboxSchema,
  DeveloperAccessSchema,
  DeveloperSandboxSchema,
  OkSchema,
  ResetDeveloperSandboxSchema,
  SandboxResetSchema,
  TryTokenSchema,
} from '../../../shared/contracts/index.ts';
import { hasDeveloperAccess } from '../../../shared/spaces.ts';
import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { deleteOwnSandbox, recreateSandbox } from './delete.ts';
import { developerHome } from './home.ts';
import { reopenOwnSandbox, resetSandbox } from './reset.ts';
import { developerLogRoutes } from './routes-logs.ts';
import { closeOwnSandbox, createSandbox, getSandbox } from './service.ts';
import { mintTryToken, revokeTryTokens } from './try-token.ts';

export const developerRoutes = createRouter();
developerRoutes.use('*', limitBody(8 * 1024));
developerRoutes.route('/', developerLogRoutes);

register(
  developerRoutes,
  'developer',
  {
    method: 'get',
    path: '/access',
    summary:
      'Whether you have developer access: yes, none, or an email sign-in that needs Polaris ID',
    operationId: 'developer.getAccess',
    auth: { human: true, signIn: 'any' },
    response: DeveloperAccessSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    c.header('cache-control', 'no-store');
    if (auth.amr === 'magic_link')
      return c.json({ access: 'email' as const, signInUrl: '/auth/oidc/start?next=/developers' });
    return c.json({
      access: hasDeveloperAccess(auth.roles) ? ('yes' as const) : ('none' as const),
    });
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'get',
    path: '/home',
    summary:
      'Your workbench: sandbox, quickstart track, usage, keys, latest calls, webhooks, passes and Live orgs',
    operationId: 'developer.getHome',
    auth: { human: true, developer: true },
    response: DeveloperHomeSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    c.header('cache-control', 'no-store');
    return c.json(await developerHome(serviceContext(c), auth));
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox',
    summary: 'Make your developer sandbox: a test organization whose passes are previews',
    operationId: 'developer.postSandbox',
    auth: { human: true, signIn: 'strict', developer: true },
    body: CreateDeveloperSandboxSchema,
    status: 201,
    response: CreatedDeveloperSandboxSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${auth.userId}`);
    const input = c.req.valid('json');
    if (
      !(await verifyTurnstile(
        c.env,
        input.turnstileToken,
        clientIp(c),
        ctx.log,
        fetch,
        TURNSTILE_SANDBOX_ACTION,
      ))
    ) {
      ctx.log.warn('developer.turnstile_failed', { code: 'TURNSTILE_FAILED' });
      throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
    }
    return c.json(await createSandbox(ctx, auth, {}, { viewedAt: input.viewedAt }), 201);
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'get',
    path: '/sandbox',
    summary: 'Your developer sandbox, or null, and the site key for the check that makes one',
    operationId: 'developer.getSandbox',
    auth: { human: true, developer: true },
    response: z.object({
      sandbox: DeveloperSandboxSchema.nullable(),
      turnstileSiteKey: z.string(),
    }),
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    return c.json({
      sandbox: await getSandbox(serviceContext(c), auth),
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    });
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/close',
    summary: 'Close your developer sandbox: its keys stop and it goes read-only',
    operationId: 'developer.postSandboxClose',
    auth: { human: true, signIn: 'strict', developer: true },
    response: DeveloperSandboxSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await closeOwnSandbox(serviceContext(c), auth));
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'delete',
    path: '/sandbox',
    summary:
      'Delete your developer sandbox, open or closed: keys, passes, webhooks, logs and templates go, and you can make a new one. Three a day.',
    operationId: 'developer.deleteSandbox',
    auth: { human: true, signIn: 'strict', developer: true },
    response: DeveloperSandboxSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await deleteOwnSandbox(serviceContext(c), auth));
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/recreate',
    summary:
      'Start over from nothing: delete your sandbox and make a new one, with a new key shown once. Counts as a delete.',
    operationId: 'developer.postSandboxRecreate',
    auth: { human: true, signIn: 'strict', developer: true },
    body: CreateDeveloperSandboxSchema,
    status: 201,
    response: CreatedDeveloperSandboxSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(c.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${auth.userId}`);
    const input = c.req.valid('json');
    if (
      !(await verifyTurnstile(
        c.env,
        input.turnstileToken,
        clientIp(c),
        ctx.log,
        fetch,
        TURNSTILE_SANDBOX_ACTION,
      ))
    ) {
      ctx.log.warn('developer.turnstile_failed', { code: 'TURNSTILE_FAILED' });
      throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
    }
    return c.json(await recreateSandbox(ctx, auth, { viewedAt: input.viewedAt }), 201);
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/reset',
    summary:
      'Start over: delete your sandbox test passes, captured webhooks and request log, restart the quickstart and replace the key',
    operationId: 'developer.postSandboxReset',
    auth: {
      human: true,
      signIn: 'strict',
      developer: true,
      stepUp: { maxAgeSec: STEP_UP_SECONDS },
    },
    body: ResetDeveloperSandboxSchema,
    response: SandboxResetSchema,
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
    if (
      !(await verifyTurnstile(
        c.env,
        c.req.valid('json').turnstileToken,
        clientIp(c),
        ctx.log,
        fetch,
        TURNSTILE_SANDBOX_ACTION,
      ))
    ) {
      ctx.log.warn('developer.turnstile_failed', { code: 'TURNSTILE_FAILED' });
      throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
    }
    c.header('cache-control', 'no-store');
    return c.json(await resetSandbox(ctx, auth));
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/sandbox/reopen',
    summary: 'Reopen your closed sandbox inside its 30 days, with a new key',
    operationId: 'developer.postSandboxReopen',
    auth: {
      human: true,
      signIn: 'strict',
      developer: true,
      stepUp: { maxAgeSec: STEP_UP_SECONDS },
    },
    response: CreatedDeveloperSandboxSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await enforceRateLimit(
      c.env,
      'RL_REFRESH',
      `RL_REFRESH:developer-sandbox-reopen:${auth.userId}`,
    );
    c.header('cache-control', 'no-store');
    return c.json(await reopenOwnSandbox(serviceContext(c), auth));
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'post',
    path: '/try-token',
    summary: 'A 15-minute token for Try it: your sandbox key, Test only, ends with this session',
    operationId: 'developer.postTryToken',
    auth: { human: true, signIn: 'strict', developer: true },
    status: 201,
    response: TryTokenSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    c.header('cache-control', 'no-store');
    return c.json(await mintTryToken(serviceContext(c), auth), 201);
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'delete',
    path: '/try-token',
    summary: 'End every Try it token of your sandbox',
    operationId: 'developer.deleteTryToken',
    auth: { human: true, signIn: 'strict', developer: true },
    response: OkSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await revokeTryTokens(serviceContext(c), auth);
    return c.json({ ok: true as const });
  },
);
