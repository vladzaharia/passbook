import {
  ChangePreviewBodySchema,
  ChangeRunPreviewSchema,
  CreateBroadcastBodySchema,
  RetryQuerySchema,
  UpdateBroadcastBodySchema,
} from '../../../shared/contracts/broadcasts-change.ts';
import {
  BroadcastItemListQuerySchema,
  BroadcastItemListSchema,
  BroadcastListQuerySchema,
  BroadcastListSchema,
  BroadcastSchema,
  IdParamSchema,
  SendBroadcastSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { idempotencyKeyOf, sendOnce } from '../delivery/idempotent-send.ts';
import { activeMembership } from '../orgs/repo-members.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  orgIdOf,
  passScopeOf,
  requireTenantSessionOrApiKey,
  svc,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { limitChanges } from './change-limit.ts';
import { previewChange } from './change-preview.ts';
import { type BroadcastScope, requireBroadcast } from './guards.ts';
import { registerChangeRoutes } from './routes-change.ts';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcastDto,
  listBroadcastDtos,
  sendBroadcast,
} from './service.ts';
import { listBroadcastItems, retryBroadcast, updateBroadcast } from './service-edit.ts';
import { tellHoldersKey } from './tell-key.ts';
import { unsupportedFilter } from './unsupported-filter.ts';

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
  // A session that changes passes needs passes:operate too: without it the run would fail at its first write.
  if (row.kind === 'change' && capability === 'messages:manage' && auth.kind === 'session')
    await tenantAuthorityOf(ctx, auth, row.org_id, 'passes:operate');
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
    const orgId = orgIdOf(auth, q.orgId);
    assertOrg(c, orgId);
    await tenantAuthorityOf(ctx, auth, orgId, 'messages:read');
    return c.json(
      await listBroadcastDtos(ctx, {
        orgId,
        mode: modeOf(auth),
        state: q.state,
        origin: q.origin,
        kind: q.kind,
        parentId: q.parentId,
        retryOf: q.retryOf,
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
    codes: ['BROADCAST_UNSUPPORTED_FILTER'],
    invalid: unsupportedFilter,
    summary: 'Save, send or schedule a message or change (Idempotency-Key)',
    body: CreateBroadcastBodySchema,
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
    if (body.kind === 'change' && auth.kind === 'session')
      await tenantAuthorityOf(ctx, auth, body.orgId, 'passes:operate');
    const mode = modeOf(auth);
    let inserted = false;
    const create = () =>
      createBroadcast(ctx, actorFor(c), mode, body, authority, {
        onInserted: () => {
          inserted = true;
        },
        ...(body.kind === 'change' ? { limit: () => limitChanges(ctx, authority) } : {}),
      });
    const key = idempotencyKeyOf(c.req.header('idempotency-key'));
    if (key === undefined) return c.json(await create(), 201);
    const tellKey = await tellHoldersKey(ctx, mode, body, key);
    const { value } = await sendOnce(
      ctx,
      {
        orgId: body.orgId,
        scope: `broadcast-create:${mode}`,
        key,
        request: body,
        authority,
        progress: () => inserted,
        // Tell holders sends once per release for the organization, not once per admin.
        shared: tellKey !== null,
      },
      create,
    );
    return c.json(value, 201);
  },
);

register(
  broadcastsRoutes,
  'broadcasts',
  {
    method: 'post',
    path: '/preview',
    codes: ['BROADCAST_UNSUPPORTED_FILTER'],
    invalid: unsupportedFilter,
    summary: 'Count the passes a target matches',
    body: ChangePreviewBodySchema,
    response: ChangeRunPreviewSchema,
  },
  async (c) => {
    const ctx = svc(c);
    const auth = authOf(c);
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    await tenantAuthorityOf(ctx, auth, body.orgId, 'messages:read');
    // Samples show each pass's own values: reading them needs the right to read passes.
    if (body.patch) {
      if (auth.kind === 'api_key' && !auth.scopes.includes('passes:read'))
        throw new ForbiddenError('A change preview needs the passes:read scope.', 'MISSING_SCOPE');
      if (auth.kind === 'session') await tenantAuthorityOf(ctx, auth, body.orgId, 'passes:read');
    }
    return c.json(await previewChange(ctx, modeOf(auth), body));
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
    codes: ['BROADCAST_UNSUPPORTED_FILTER'],
    invalid: unsupportedFilter,
    summary: 'Edit a draft or a scheduled message that has not started',
    params: IdParamSchema,
    body: UpdateBroadcastBodySchema,
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
    summary:
      'Send a failed or canceled message again, as a new one in the same mode; a change resumes (expectCount)',
    params: IdParamSchema,
    query: RetryQuerySchema,
    status: 201,
    response: BroadcastSchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    const scope = await scopeOf(c, id, 'messages:manage');
    return c.json(
      await retryBroadcast(svc(c), actorFor(c), id, scope, c.req.valid('query').expectCount),
      201,
    );
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

registerChangeRoutes(broadcastsRoutes, scopeOf);
