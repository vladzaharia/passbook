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
import { modeOf, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { actorFor, assertOrg, authOf, orgScopeOf, passScopeOf, svc } from '../passes/http.ts';
import type { BroadcastScope } from './guards.ts';
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

const scopeOf = (c: Ctx): BroadcastScope => ({ ...passScopeOf(c), canChange: canChange(c) });

/** /api/v1/broadcasts: messages and scheduled changes for the passes a target matches. */
export const broadcastsRoutes = createRouter();
guard(broadcastsRoutes, requireApiKeyOrAdmin('messages:write'));

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
    const q = c.req.valid('query');
    if (q.orgId) assertOrg(c, q.orgId);
    return c.json(
      await listBroadcastDtos(svc(c), {
        orgScope: orgScopeOf(c),
        orgId: q.orgId,
        mode: modeOf(authOf(c)),
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
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    if (body.kind === 'change' && !canChange(c))
      throw new ForbiddenError('Changing passes needs the passes:write scope.', 'MISSING_SCOPE');
    return c.json(await createBroadcast(svc(c), actorFor(c), modeOf(authOf(c)), body), 201);
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
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    return c.json(await previewTarget(svc(c), modeOf(authOf(c)), body.orgId, body.target));
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
  async (c) => c.json(await getBroadcastDto(svc(c), c.req.valid('param').id, passScopeOf(c))),
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
    return c.json(await sendBroadcast(svc(c), actorFor(c), id, c.req.valid('json').at, scopeOf(c)));
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
  async (c) =>
    c.json(await cancelBroadcast(svc(c), actorFor(c), c.req.valid('param').id, scopeOf(c))),
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
    const body = c.req.valid('json');
    assertOrg(c, body.orgId);
    return c.json(
      await updateBroadcast(svc(c), actorFor(c), c.req.valid('param').id, body, scopeOf(c)),
    );
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
  async (c) =>
    c.json(await retryBroadcast(svc(c), actorFor(c), c.req.valid('param').id, scopeOf(c)), 201),
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
    const auth = authOf(c);
    if (auth.kind === 'api_key' && !auth.scopes.includes('passes:read'))
      throw new ForbiddenError(
        "Listing a message's passes needs the passes:read scope.",
        'MISSING_SCOPE',
      );
    return c.json(
      await listBroadcastItems(
        svc(c),
        c.req.valid('param').id,
        passScopeOf(c),
        c.req.valid('query'),
      ),
    );
  },
);
