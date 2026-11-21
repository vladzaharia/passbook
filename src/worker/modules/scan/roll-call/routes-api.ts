import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { IdParamSchema, IdSchema } from '../../../../shared/contracts/common.ts';
import {
  RollCallCurrentSchema,
  RollCallMarksRequestSchema,
  RollCallMarksResponseSchema,
  RollCallSchema,
} from '../../../../shared/contracts/scan-roll-call.ts';
import { atLeast } from '../../../platform/api-version.ts';
import { assertOrgAccess } from '../../../platform/auth.ts';
import { limitBody } from '../../../platform/body-limit.ts';
import type { AppBindings } from '../../../platform/context.ts';
import { UnauthenticatedError, ValidationError } from '../../../platform/errors.ts';
import { createRouter, register } from '../../../platform/openapi.ts';
import { declareKeyAccess } from '../../../platform/openapi-security.ts';
import { serviceContext } from '../../../platform/service-context.ts';
import {
  authOf,
  type C,
  requireTenantSessionOrApiKey,
  tenantAuthorityOf,
} from '../../passes/http.ts';
import { type Caller, tenantCaller } from './caller.ts';
import { markRollCall } from './marks.ts';
import { keyScopes } from './repo.ts';
import { currentRollCall, endRollCall, readRollCall, startRollCall } from './service.ts';

const TAG = 'roll-calls';
const OrgQuerySchema = z.object({
  /** Needed for a signed-in user; an org's API key already names its org. */
  orgId: IdSchema.optional(),
  /** One scanning session's places; omitted, every tracked zone of the org. */
  sessionId: IdSchema.optional(),
});

/**
 * /api/v1/roll-calls: the console and API keys. `scans:read` reads, `scans:write` starts, confirms and ends.
 * A key is the way a script or a safety system reaches a roll call; the scanner has its own routes.
 */
export const rollCallRoutes = createRouter();
const read = requireTenantSessionOrApiKey(['scans:read']);
// A till key starts, confirms and ends a roll call for its terminals: `scanning.devices`, not `api`, governs it.
const write = requireTenantSessionOrApiKey(['scans:write'], { tillKey: true });
rollCallRoutes.use(
  '*',
  declareKeyAccess(
    createMiddleware<AppBindings>(async (c, next) =>
      c.req.method === 'GET' ? read(c, next) : write(c, next),
    ),
    { read: ['scans:read'], write: ['scans:write'] },
  ),
);
rollCallRoutes.use('*', limitBody(16 * 1024));

async function callerOf(c: C, q: z.infer<typeof OrgQuerySchema>, write: boolean): Promise<Caller> {
  const auth = authOf(c);
  const orgId = auth.kind === 'api_key' ? (auth.orgId ?? q.orgId) : q.orgId;
  if (!orgId) throw new ValidationError('Select an organization.', [], 'ORG_REQUIRED');
  if (auth.kind === 'api_key') assertOrgAccess(auth, orgId);
  const ctx = serviceContext(c);
  const authority = await tenantAuthorityOf(
    ctx,
    auth,
    orgId,
    write ? 'passes:operate' : 'scanning:read',
    { tillKey: true },
  );
  const who =
    auth.kind === 'session'
      ? { type: 'user' as const, id: auth.userId, name: 'Admin console' }
      : auth.kind === 'api_key'
        ? { type: 'api_key' as const, id: auth.keyId, name: 'API key' }
        : null;
  if (!who) throw new UnauthenticatedError();
  // A till key acts as its terminals: only their sessions' calls.
  const allowed =
    auth.kind === 'api_key' && auth.scopes.includes('scans:write')
      ? await keyScopes(ctx.env.DB, auth.keyId)
      : undefined;
  return tenantCaller(
    ctx,
    authority,
    who,
    q.sessionId ?? null,
    allowed,
    auth.kind === 'session' ? auth : undefined,
  );
}

register(
  rollCallRoutes,
  TAG,
  {
    method: 'get',
    path: '/',
    summary: 'The open roll call',
    query: OrgQuerySchema,
    response: RollCallCurrentSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(
      await currentRollCall(serviceContext(c), await callerOf(c, c.req.valid('query'), false)),
    );
  },
);
register(
  rollCallRoutes,
  TAG,
  {
    method: 'post',
    path: '/',
    summary: 'Start a roll call, or join the open one',
    query: OrgQuerySchema,
    status: 201,
    response: RollCallSchema,
  },
  async (c) => {
    const call = await startRollCall(
      serviceContext(c),
      await callerOf(c, c.req.valid('query'), true),
    );
    // 200 until a client pins PassBook-Version 2026-11-20 (docs/api/versions.json).
    return c.json(call, atLeast(c, '2026-11-20') ? 201 : 200);
  },
);
register(
  rollCallRoutes,
  TAG,
  {
    method: 'get',
    path: '/{id}',
    summary: 'A roll call',
    params: IdParamSchema,
    query: OrgQuerySchema,
    response: RollCallSchema,
  },
  async (c) => {
    c.header('cache-control', 'no-store');
    const caller = await callerOf(c, c.req.valid('query'), false);
    return c.json(await readRollCall(serviceContext(c), caller, c.req.valid('param').id));
  },
);
register(
  rollCallRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/marks',
    summary: 'Confirm people present or out',
    params: IdParamSchema,
    query: OrgQuerySchema,
    body: RollCallMarksRequestSchema,
    response: RollCallMarksResponseSchema,
  },
  async (c) => {
    const caller = await callerOf(c, c.req.valid('query'), true);
    return c.json(
      await markRollCall(
        serviceContext(c),
        caller,
        c.req.valid('param').id,
        c.req.valid('json').marks,
      ),
    );
  },
);
register(
  rollCallRoutes,
  TAG,
  {
    method: 'post',
    path: '/{id}/end',
    summary: 'End a roll call',
    params: IdParamSchema,
    query: OrgQuerySchema,
    response: RollCallSchema,
  },
  async (c) => {
    const caller = await callerOf(c, c.req.valid('query'), true);
    return c.json(await endRollCall(serviceContext(c), caller, c.req.valid('param').id));
  },
);
