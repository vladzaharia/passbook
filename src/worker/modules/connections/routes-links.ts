import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { IdParamSchema, OkSchema } from '../../../shared/contracts/common.ts';
import {
  CreateLinkSchema,
  LinkFindQuerySchema,
  LinkListQuerySchema,
  LinkListSchema,
  LinkParamSchema,
  LinkSchema,
} from '../../../shared/contracts/connections-links.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection, authorizeStoredConnection } from './access.ts';
import { bindLink, findLinks, listConnectionLinks, unbindLink } from './links.ts';
import { connectionListOrg } from './list-routes.ts';
import { requireConnection } from './service-shared.ts';

type C = Context<AppBindings>;
type Capability = 'integrations:read' | 'integrations:manage';

/** Stored connections and their links have no Test environment. */
function assertLive(c: C): void {
  if (modeOf(c.var.auth) !== 'live')
    throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
}

async function authorizeById(c: C, id: string, capability: Capability) {
  const ctx = serviceContext(c);
  const conn = await requireConnection(ctx, id);
  return authorizeStoredConnection(ctx, c.var.auth, conn.orgId, capability);
}

/** `/{id}/links` of the connections router. Scopes `connections:read` and `connections:write` come from its guard. */
export function registerConnectionLinkRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/{id}/links',
      summary: 'List the links of a connection',
      params: IdParamSchema,
      query: LinkListQuerySchema,
      response: LinkListSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').id;
      await authorizeById(c, id, 'integrations:read');
      return c.json(await listConnectionLinks(serviceContext(c), id, c.req.valid('query')));
    },
  );
  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/{id}/links',
      summary: 'Link a pass to an upstream object',
      params: IdParamSchema,
      body: CreateLinkSchema,
      status: 201,
      response: LinkSchema,
    },
    async (c) => {
      assertLive(c);
      const id = c.req.valid('param').id;
      const authority = await authorizeById(c, id, 'integrations:manage');
      const link = await bindLink(
        serviceContext(c),
        actorOf(c.var.auth),
        id,
        c.req.valid('json'),
        authority,
      );
      return c.json(link, 201);
    },
  );
  register(
    router,
    'connections',
    {
      method: 'delete',
      path: '/{id}/links/{linkId}',
      summary: 'Remove a link',
      params: LinkParamSchema,
      response: OkSchema,
    },
    async (c) => {
      assertLive(c);
      const { id, linkId } = c.req.valid('param');
      const authority = await authorizeById(c, id, 'integrations:manage');
      await unbindLink(serviceContext(c), actorOf(c.var.auth), id, linkId, authority);
      return c.json({ ok: true as const });
    },
  );
}

/** /api/v1/links */
export const linksRoutes = createRouter({ bodyLimit: false });
guard(
  linksRoutes,
  declareKeyAccess(
    requireTenantSessionOrApiKey(
      methodScope({ read: 'connections:read', write: 'connections:write' }),
    ),
    {
      read: ['connections:read'],
      write: ['connections:write'],
    },
  ),
);
register(
  linksRoutes,
  'connections',
  {
    method: 'get',
    path: '/',
    summary: 'Find links by connection, object type or upstream id',
    query: LinkFindQuerySchema,
    response: LinkListSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = serviceContext(c);
    const { connectionId, orgId: requested, ...query } = c.req.valid('query');
    const orgId = connectionId
      ? (await requireConnection(ctx, connectionId)).orgId
      : connectionListOrg(c, requested);
    if (connectionId) await authorizeStoredConnection(ctx, c.var.auth, orgId, 'integrations:read');
    else await authorizeConnection(ctx, c.var.auth, orgId, 'integrations:read');
    return c.json(await findLinks(ctx, orgId, { connectionId, ...query }, query));
  },
);
