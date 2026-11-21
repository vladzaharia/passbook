import { z } from 'zod';
import {
  CreateDeveloperSandboxSchema,
  CreatedDeveloperSandboxSchema,
  DeveloperSandboxSchema,
  OkSchema,
  TryTokenSchema,
} from '../../../shared/contracts/index.ts';
import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
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
    method: 'post',
    path: '/sandbox',
    summary: 'Make your developer sandbox: a test organization whose passes are previews',
    operationId: 'developer.postSandbox',
    auth: { human: true },
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
    auth: { human: true },
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
    method: 'delete',
    path: '/sandbox',
    summary: 'Close your developer sandbox: its keys stop and it goes read-only',
    operationId: 'developer.deleteSandbox',
    auth: { human: true },
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
    method: 'post',
    path: '/try-token',
    summary: 'A 15-minute token for Try it: your sandbox key, Test only, ends with this session',
    operationId: 'developer.postTryToken',
    auth: { human: true },
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
    auth: { human: true },
    response: OkSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    await revokeTryTokens(serviceContext(c), auth);
    return c.json({ ok: true as const });
  },
);
