import {
  BroadcastItemListQuerySchema,
  BroadcastItemListSchema,
  BroadcastListQuerySchema,
  BroadcastListSchema,
  BroadcastPreviewBodySchema,
  BroadcastPreviewSchema,
  BroadcastSchema,
  CreateBroadcastSchema,
  IdParamSchema,
  SendBroadcastSchema,
  UpdateBroadcastSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  requireTenantSessionOrApiKey,
  svc,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { type BroadcastScope, requireBroadcast } from './guards.ts';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcastDto,
  listBroadcastDtos,
  previewTarget,
  sendBroadcast,
} from './service.ts';
import { listBroadcastItems, retryBroadcast, updateBroadcast } from './service-edit.ts';

type Ctx = Parameters<typeof authOf>[0];

/** A change edits pass inputs, so an API key needs passes:write beside messages:write. */
const canChange = (c: Ctx): boolean => {
  const auth = authOf(c);
  return auth.kind !== 'api_key' || auth.scopes.includes('passes:write');
};

type BroadcastCapability = 'messages:read' | 'messages:manage';

/** Bind by-id access to the stored org, masking resources outside a session's memberships. */
async function scopeOf(
  c: Ctx,
  id: string,
  capability: BroadcastCapability,
): Promise<BroadcastScope> {
  const ctx = svc(c);
  const auth = authOf(c);
  const scope = passScopeOf(c);
  const row = await requireBroadcast(ctx, id, scope);
  let authority: TenantPassWrite;
  try {
    authority = await tenantAuthorityOf(ctx, auth, row.org_id, capability);
  } catch (error) {
    if (
      error instanceof ForbiddenError &&
      auth.kind === 'session' &&
      !(await activeMembership(ctx.env.DB, auth.userId, row.org_id))
    ) {
      throw new NotFoundError('Message not found.', 'BROADCAST_NOT_FOUND');
    }
    throw error;
  }
  return { ...scope, orgId: row.org_id, canChange: canChange(c), authority };
}

/** /api/v1/broadcasts: messages and scheduled changes for the passes a target matches. */
export const broadcastsRoutes = createRouter();
guard(broadcastsRoutes, requireTenantSessionOrApiKey('messages:write'));

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'get',
    path: '/',
    summary: 'List messages and scheduled changes',
    query: BroadcastListQuerySchema,
    response: BroadcastListSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const q = c.req.valid('query');
    const orgId = q.orgId ?? (auth.kind === 'api_key' ? auth.orgId : null);
    if (!orgId)
      throw new ValidationError('Choose an organization.', [
        { path: 'orgId', message: 'Choose an organization.' },
      ]);
    assertOrg(c, orgId);
    await tenantAuthorityOf(ctx, auth, orgId, 'messages:read');
    return c.json(
      await listBroadcastDtos(ctx, {
        orgId,
        mode: modeOf(auth),
        state: q.state,
        cursor: q.cursor,
        limit: q.limit,
      }),
    );
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/',
    summary: 'Save, send or schedule a message or change',
    body: CreateBroadcastSchema,
    status: 201,
    response: BroadcastSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    const authority = await tenantAuthorityOf(ctx, auth, body.orgId, 'messages:manage');
    if (body.kind === 'change' && !canChange(c))
      throw new ForbiddenError('Changing passes needs the passes:write scope.', 'MISSING_SCOPE');
    return c.json(await createBroadcast(ctx, actorFor(c), modeOf(auth), body, authority), 201);
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/preview',
    summary: 'Count the passes a target matches',
    body: BroadcastPreviewBodySchema,
    response: BroadcastPreviewSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    await tenantAuthorityOf(ctx, auth, body.orgId, 'messages:read');
    return c.json(await previewTarget(ctx, modeOf(auth), body.orgId, body.target));
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'get',
    path: '/{id}',
    summary: 'One message or change, with progress',
    params: IdParamSchema,
    response: BroadcastSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:read');
    return c.json(await getBroadcastDto(svc(c), id, scope));
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/{id}/send',
    summary: 'Send a draft now or at a time',
    params: IdParamSchema,
    body: SendBroadcastSchema,
    response: BroadcastSchema,
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const scope = await scopeOf(c, id, 'messages:manage');
    return c.json(await sendBroadcast(svc(c), actorFor(c), id, c.req.valid('json').at, scope));
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/{id}/cancel',
    summary: 'Cancel a draft or scheduled message',
    params: IdParamSchema,
    response: BroadcastSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:manage');
    return c.json(await cancelBroadcast(svc(c), actorFor(c), id, scope));
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Edit a draft or a scheduled message that has not started',
    params: IdParamSchema,
    body: UpdateBroadcastSchema,
    response: BroadcastSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:manage');
    const body = c.req.valid('json');
    return c.json(await updateBroadcast(svc(c), actorFor(c), id, body, scope));
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/{id}/retry',
    summary: 'Send a failed or cancelled message again, as a new one in the same mode',
    params: IdParamSchema,
    status: 201,
    response: BroadcastSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:manage');
    return c.json(await retryBroadcast(svc(c), actorFor(c), id, scope), 201);
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'get',
    path: '/{id}/items',
    summary: 'The passes a message reached: updated, unchanged or failed',
    params: IdParamSchema,
    query: BroadcastItemListQuerySchema,
    response: BroadcastItemListSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:read');
    const auth = authOf(c);
    if (auth.kind === 'api_key' && !auth.scopes.includes('passes:read'))
      throw new ForbiddenError(
        "Listing a message's passes needs the passes:read scope.",
        'MISSING_SCOPE',
      );
    return c.json(await listBroadcastItems(svc(c), id, scope, c.req.valid('query')));
  },
);
