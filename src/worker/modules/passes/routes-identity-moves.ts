import type { Context } from 'hono';
import {
  IdentityMoveArmedSchema,
  IdentityMoveListQuerySchema,
  IdentityMoveListSchema,
  IdentityMoveOrgQuerySchema,
  IdentityMoveParamSchema,
  IdentityMovePreviewSchema,
  IdentityMoveRequestSchema,
} from '../../../shared/contracts/identity-moves.ts';
import { OperationSchema } from '../../../shared/contracts/operations.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, ForbiddenError } from '../../platform/errors.ts';
import { idempotentJson, principalOf } from '../../platform/idempotency.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { operationIdFor } from '../operations/start.ts';
import { authOf } from './http.ts';
import { armMoveById } from './identity-move-arm.ts';
import { listIdentityMoves } from './identity-move-list.ts';
import { previewIdentityMove, startIdentityMove } from './identity-move-start.ts';

/** Person-only: a platform admin session. A key never reaches these routes, and no token retries or cancels the operation. */
const READ = { platform: 'platform:identities' } as const;
const WRITE = { ...READ, stepUp: { maxAgeSec: STEP_UP_SECONDS } } as const;
const ERRORS = ['IDEMPOTENCY_KEY_REQUIRED', 'ORG_NOT_FOUND', 'IDENTITY_NOT_FOUND'] as const;

function requireIdempotencyKey(c: Context<AppBindings>): void {
  if (!c.req.header('idempotency-key')?.trim())
    throw new BadRequestError('Send an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
}

/** The route's own check, beyond the platform fence: a person at the console. */
function adminOf(c: Context<AppBindings>): { userId: string } {
  const auth = authOf(c);
  if (auth.kind !== 'session' || !auth.roles.includes('admin')) throw new ForbiddenError();
  return { userId: auth.userId };
}

/** Mount at /api/v1/platform/apple/identity-moves. */
export const identityMoveRoutes = createRouter();

register(
  identityMoveRoutes,
  'wallet identities',
  {
    method: 'get',
    path: '/preview',
    summary: 'Dry run of an identity move: what would move and what stays, by reason',
    query: IdentityMoveOrgQuerySchema,
    response: IdentityMovePreviewSchema,
    auth: READ,
    codes: [...ERRORS, 'IDENTITY_MOVE_SAME'],
  },
  async (c) => {
    adminOf(c);
    const q = c.req.valid('query');
    return c.json(await previewIdentityMove(serviceContext(c), q));
  },
);

register(
  identityMoveRoutes,
  'wallet identities',
  {
    method: 'get',
    path: '/',
    summary: 'Move rows with their state and reason, including kept_both and unarmed',
    query: IdentityMoveListQuerySchema,
    response: IdentityMoveListSchema,
    auth: READ,
  },
  async (c) => {
    adminOf(c);
    return c.json(await listIdentityMoves(serviceContext(c), c.req.valid('query')));
  },
);

register(
  identityMoveRoutes,
  'wallet identities',
  {
    method: 'post',
    path: '/',
    summary: "Start moving an org's passes to another identity (Idempotency-Key)",
    body: IdentityMoveRequestSchema,
    status: 202,
    response: OperationSchema,
    auth: WRITE,
    codes: [...ERRORS, 'IDENTITY_MOVE_SAME', 'OPERATION_RUNNING'],
  },
  async (c) => {
    requireIdempotencyKey(c);
    const by = adminOf(c);
    const ctx = serviceContext(c);
    const body = c.req.valid('json');
    const principal = principalOf(authOf(c));
    const key = c.req.header('idempotency-key')?.trim() ?? '';
    return idempotentJson(
      c,
      ctx,
      { orgId: 'platform', mode: 'live', principal, body },
      202,
      async () =>
        startIdentityMove(ctx, by, {
          ...body,
          id: await operationIdFor(principal, 'identity.move', key),
        }),
    );
  },
);

register(
  identityMoveRoutes,
  'wallet identities',
  {
    method: 'post',
    path: '/{moveId}/arm',
    summary: "Start a move row's 24 hours now (Idempotency-Key)",
    params: IdentityMoveParamSchema,
    response: IdentityMoveArmedSchema,
    auth: WRITE,
    codes: ['IDEMPOTENCY_KEY_REQUIRED', 'IDENTITY_MOVE_CONFLICT', 'NOT_FOUND'],
  },
  async (c) => {
    requireIdempotencyKey(c);
    const by = adminOf(c);
    const ctx = serviceContext(c);
    const { moveId } = c.req.valid('param');
    const principal = principalOf(authOf(c));
    return idempotentJson(
      c,
      ctx,
      { orgId: 'platform', mode: 'live', principal, body: { moveId } },
      200,
      async () => {
        await armMoveById(ctx, by, moveId);
        return { moveId, armed: true as const };
      },
    );
  },
);
