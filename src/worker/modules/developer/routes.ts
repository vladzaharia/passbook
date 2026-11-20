import { z } from 'zod';
import {
  CreateDeveloperSandboxSchema,
  CreatedDeveloperSandboxSchema,
  DeveloperSandboxSchema,
} from '../../../shared/contracts/index.ts';
import { TURNSTILE_SANDBOX_ACTION } from '../../../shared/turnstile.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { verifyTurnstile } from '../auth/turnstile.ts';
import { closeOwnSandbox, createSandbox, getSandbox } from './service.ts';

export const developerRoutes = createRouter();
developerRoutes.use('*', limitBody(8 * 1024));

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
    return c.json(await createSandbox(ctx, auth), 201);
  },
);

register(
  developerRoutes,
  'developer',
  {
    method: 'get',
    path: '/sandbox',
    summary: 'Your developer sandbox, or null',
    operationId: 'developer.getSandbox',
    auth: { human: true },
    response: z.object({ sandbox: DeveloperSandboxSchema.nullable() }),
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    return c.json({ sandbox: await getSandbox(serviceContext(c), auth) });
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
