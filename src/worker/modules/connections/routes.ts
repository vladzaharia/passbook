import type { Context } from 'hono';
import {
  ConnectionCreatedSchema,
  ConnectionDetailSchema,
  ConnectionRunListSchema,
  ConnectionRunsQuerySchema,
  CreateConnectionSchema,
  IdParamSchema,
  OkSchema,
  SyncNowResponseSchema,
  TestConfigResponseSchema,
  TestConfigSchema,
  TestConnectionResponseSchema,
  UpdateConnectionSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection, authorizeStoredConnection as authorizeStored } from './access.ts';
import * as actions from './actions.ts';
import { registerConnectorCatalogRoutes } from './catalog-routes.ts';
import { registerConnectionListRoutes } from './list-routes.ts';
import * as service from './service.ts';
import { testConfig } from './test-config.ts';
import { registerConnectionWebhookRoutes } from './webhook-ingress-routes.ts';
import { registerWebhookRetentionRoutes } from './webhook-retention-routes.ts';

type C = Context<AppBindings>;
const actor = (c: C) => actorOf(c.var.auth);
const sctx = (c: C) => serviceContext(c);

async function authorizeStoredConnection(
  c: C,
  ctx: ServiceContext,
  id: string,
  capability: 'integrations:read' | 'integrations:manage',
) {
  const connection = await service.requireConnection(ctx, id);
  return authorizeStored(ctx, c.var.auth, connection.orgId, capability);
}

/** Stored connections have no Test environment; do not expose Live data in Test. */
function assertLive(c: C): void {
  if (modeOf(c.var.auth) !== 'live') {
    throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
  }
}

/** /api/v1/connections */
export const connectionsRoutes = createRouter();
guard(
  connectionsRoutes,
  requireTenantSessionOrApiKey(
    methodScope({ read: 'connections:read', write: 'connections:write' }),
  ),
);
registerWebhookRetentionRoutes(connectionsRoutes);
registerConnectionListRoutes(connectionsRoutes);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'post',
    path: '/',
    summary: 'Create a connection',
    body: CreateConnectionSchema,
    status: 201,
    response: ConnectionCreatedSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const input = c.req.valid('json');
    const authority = await authorizeConnection(
      ctx,
      c.var.auth,
      input.orgId,
      'integrations:manage',
    );
    return c.json(await service.create(ctx, actor(c), input, authority), 201);
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Connection with runs and metrics',
    params: IdParamSchema,
    response: ConnectionDetailSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    await authorizeStoredConnection(c, ctx, id, 'integrations:read');
    return c.json(await service.getDetail(ctx, id));
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update a connection',
    params: IdParamSchema,
    body: UpdateConnectionSchema,
    response: ConnectionCreatedSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    return c.json(await service.update(ctx, actor(c), id, c.req.valid('json'), authority));
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete a connection',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    await service.remove(ctx, actor(c), id, authority);
    return c.json({ ok: true as const });
  },
);
connectionsRoutes.use('/test-config', async (c, next) => {
  assertLive(c);
  await next();
});
// Test reaches outside hosts with user-supplied URLs: paced per user on top of safe fetch.
connectionsRoutes.use(
  '/test-config',
  rateLimit('RL_API_KEY', (c) => `test-config:${actor(c).id ?? clientIp(c)}`),
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'post',
    path: '/test-config',
    summary: 'Test an unsaved configuration',
    body: TestConfigSchema,
    response: TestConfigResponseSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const input = c.req.valid('json');
    const authority = await authorizeConnection(
      ctx,
      c.var.auth,
      input.orgId,
      'integrations:manage',
    );
    return c.json(await testConfig(ctx, actor(c), input, authority));
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'post',
    path: '/{id}/test',
    summary: 'Test the connection',
    params: IdParamSchema,
    response: TestConnectionResponseSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    return c.json(await actions.test(ctx, actor(c), id, authority));
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'post',
    path: '/{id}/sync',
    summary: 'Sync now',
    params: IdParamSchema,
    status: 202,
    response: SyncNowResponseSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    return c.json(await actions.syncNow(ctx, actor(c), id, authority), 202);
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'get',
    path: '/{id}/runs',
    summary: 'List runs',
    params: IdParamSchema,
    query: ConnectionRunsQuerySchema,
    response: ConnectionRunListSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    await authorizeStoredConnection(c, ctx, id, 'integrations:read');
    return c.json(await actions.runs(ctx, id, c.req.valid('query')));
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'post',
    path: '/{id}/webhook-secret',
    summary: 'Generate a new webhook secret (shown once)',
    params: IdParamSchema,
    response: ConnectionCreatedSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    const { webhookSecret, connection } = await actions.rotateWebhookSecret(
      ctx,
      actor(c),
      id,
      authority,
    );
    return c.json({ ...connection, webhookSecret });
  },
);

/** /api/v1/connectors: platform catalog or a tenant-scoped integration catalog. */
export const connectorsRoutes = createRouter();
registerConnectorCatalogRoutes(connectorsRoutes);

/** /hooks/connections: signed inbound webhooks, no session. */
export const hooksRoutes = createRouter();
registerConnectionWebhookRoutes(hooksRoutes);
