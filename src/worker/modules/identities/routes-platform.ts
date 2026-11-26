import type { Context } from 'hono';
import {
  IdentityRunSchema,
  PlatformDefaultResultSchema,
  PlatformIdentityListSchema,
  StartPlatformIdentitySchema,
} from '../../../shared/contracts/identities.ts';
import { IdParamSchema } from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { authOf } from '../passes/http.ts';
import { setPlatformDefault } from './platform-default.ts';
import { listPlatformIdentities } from './platform-status.ts';
import { startPlatformIdentity } from './runs-service.ts';

/** Person-only: a platform admin session. A key never reaches these routes. */
const READ = { platform: 'platform:identities' } as const;
const WRITE = { ...READ, stepUp: { maxAgeSec: STEP_UP_SECONDS } } as const;

/** Every write here is replay-safe or refused: the key is not optional. */
function requireIdempotencyKey(c: Context<AppBindings>): void {
  if (!c.req.header('idempotency-key')?.trim())
    throw new BadRequestError('Send an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
}

/** Mount at /api/v1/platform/apple/identities. */
export const platformIdentityRoutes = createRouter();

register(
  platformIdentityRoutes,
  'platform identities',
  {
    method: 'get',
    path: '/',
    summary: "The platform's own Apple identities, with their setup runs",
    response: PlatformIdentityListSchema,
    auth: READ,
  },
  async (c) => c.json(await listPlatformIdentities(serviceContext(c))),
);

register(
  platformIdentityRoutes,
  'platform identities',
  {
    method: 'post',
    path: '/',
    summary: 'Set up a platform identity slot (Idempotency-Key)',
    body: StartPlatformIdentitySchema,
    status: 202,
    response: IdentityRunSchema,
    auth: WRITE,
    codes: ['IDEMPOTENCY_KEY_REQUIRED', 'IDENTITY_ALREADY_PROVISIONED'],
  },
  async (c) => {
    requireIdempotencyKey(c);
    const ctx = serviceContext(c);
    const body = c.req.valid('json');
    const auth = authOf(c);
    return idempotentJson(
      c,
      ctx,
      { orgId: 'platform', mode: 'live', principal: principalOf(auth), body },
      202,
      () => startPlatformIdentity(ctx, requestActor(c), body.slot),
    );
  },
);

register(
  platformIdentityRoutes,
  'platform identities',
  {
    method: 'post',
    path: '/{id}/default',
    summary: 'Make an identity the platform default (Idempotency-Key)',
    params: IdParamSchema,
    response: PlatformDefaultResultSchema,
    auth: WRITE,
    codes: ['IDEMPOTENCY_KEY_REQUIRED', 'IDENTITY_NOT_READY', 'IDENTITY_NOT_FOUND'],
  },
  async (c) => {
    requireIdempotencyKey(c);
    const ctx = serviceContext(c);
    const { id } = c.req.valid('param');
    const auth = authOf(c);
    return idempotentJson(
      c,
      ctx,
      { orgId: 'platform', mode: 'live', principal: principalOf(auth), body: { id } },
      200,
      async () => ({
        identityId: id,
        ...(await setPlatformDefault(ctx, requestActor(c), id)),
      }),
    );
  },
);
