import {
  BroadcastListQuerySchema,
  BroadcastListSchema,
  BroadcastPreviewBodySchema,
  BroadcastPreviewSchema,
  BroadcastSchema,
  CreateBroadcastSchema,
  IdParamSchema,
  SendBroadcastSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { actorFor, assertOrg, authOf, orgScopeOf, passScopeOf, svc } from '../passes/http.ts';
import {
  cancelBroadcast,
  createBroadcast,
  getBroadcastDto,
  listBroadcastDtos,
  previewTarget,
  sendBroadcast,
} from './service.ts';

/** A change edits pass inputs, so an API key needs passes:write beside messages:write. */
function assertCanChange(c: Parameters<typeof authOf>[0]): void {
  const auth = authOf(c);
  if (auth.kind === 'api_key' && !auth.scopes.includes('passes:write'))
    throw new ForbiddenError('Changing passes needs the passes:write scope.', 'MISSING_SCOPE');
}

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
    if (body.kind === 'change') assertCanChange(c);
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
    if ((await getBroadcastDto(svc(c), id, passScopeOf(c))).kind === 'change') assertCanChange(c);
    return c.json(
      await sendBroadcast(svc(c), actorFor(c), id, c.req.valid('json').at, passScopeOf(c)),
    );
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
    c.json(await cancelBroadcast(svc(c), actorFor(c), c.req.valid('param').id, passScopeOf(c))),
);
