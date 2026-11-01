import type { Context } from 'hono';
import { z } from 'zod';
import {
  ConnectionCreatedSchema,
  ConnectionDetailSchema,
  ConnectionListQuerySchema,
  ConnectionListSchema,
  ConnectionRunListSchema,
  ConnectionRunsQuerySchema,
  ConnectionsSummarySchema,
  ConnectorInfoSchema,
  ConnectorListSchema,
  CreateConnectionSchema,
  IdParamSchema,
  OkSchema,
  SyncNowResponseSchema,
  TestConfigResponseSchema,
  TestConfigSchema,
  TestConnectionResponseSchema,
  UpdateConnectionSchema,
  WebhookAckSchema,
} from '../../../shared/contracts/index.ts';
import { connectors } from '../../connectors/registry.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import * as actions from './actions.ts';
import { connectorInfo } from './dto.ts';
import * as service from './service.ts';
import { testConfig } from './test-config.ts';
import { receiveWebhook } from './webhooks.ts';

type C = Context<AppBindings>;
const actor = (c: C) => actorOf(c.var.auth);
const sctx = (c: C) => serviceContext(c);
const valid = (c: C, target: 'param' | 'query' | 'json') =>
  (c.req as unknown as { valid(t: string): unknown }).valid(target);

/** /api/v1/connections */
export const connectionsRoutes = createRouter();
guard(connectionsRoutes, requireAdmin);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'get',
    path: '/',
    summary: 'List connections',
    query: ConnectionListQuerySchema,
    response: ConnectionListSchema,
  },
  async (c: C) =>
    c.json(
      await service.listAll(
        sctx(c),
        valid(c, 'query') as z.infer<typeof ConnectionListQuerySchema>,
      ),
    ),
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'get',
    path: '/summary',
    summary: 'Connection health summary',
    response: ConnectionsSummarySchema,
  },
  async (c: C) => c.json(await actions.healthSummary(sctx(c))),
);
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
  async (c: C) =>
    c.json(
      await service.create(
        sctx(c),
        actor(c),
        valid(c, 'json') as z.infer<typeof CreateConnectionSchema>,
      ),
      201,
    ),
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
  async (c: C) =>
    c.json(await service.getDetail(sctx(c), (valid(c, 'param') as { id: string }).id)),
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
  async (c: C) =>
    c.json(
      await service.update(
        sctx(c),
        actor(c),
        (valid(c, 'param') as { id: string }).id,
        valid(c, 'json') as z.infer<typeof UpdateConnectionSchema>,
      ),
    ),
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
  async (c: C) => {
    await service.remove(sctx(c), actor(c), (valid(c, 'param') as { id: string }).id);
    return c.json({ ok: true as const });
  },
);
// Test reaches outside hosts with admin-supplied URLs: paced per admin on top of safe fetch.
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
  async (c: C) =>
    c.json(
      await testConfig(sctx(c), actor(c), valid(c, 'json') as z.infer<typeof TestConfigSchema>),
    ),
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
  async (c: C) =>
    c.json(await actions.test(sctx(c), actor(c), (valid(c, 'param') as { id: string }).id)),
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
  async (c: C) =>
    c.json(await actions.syncNow(sctx(c), actor(c), (valid(c, 'param') as { id: string }).id), 202),
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
  async (c: C) =>
    c.json(
      await actions.runs(
        sctx(c),
        (valid(c, 'param') as { id: string }).id,
        valid(c, 'query') as z.infer<typeof ConnectionRunsQuerySchema>,
      ),
    ),
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
  async (c: C) => {
    const { webhookSecret, connection } = await actions.rotateWebhookSecret(
      sctx(c),
      actor(c),
      (valid(c, 'param') as { id: string }).id,
    );
    return c.json({ ...connection, webhookSecret });
  },
);

/** /api/v1/connectors */
export const connectorsRoutes = createRouter();
guard(connectorsRoutes, requireAdmin);
register(
  connectorsRoutes,
  'connectors',
  { method: 'get', path: '/', summary: 'List connector types', response: ConnectorListSchema },
  (c: C) => c.json({ items: connectors.list().map(connectorInfo) }),
);
register(
  connectorsRoutes,
  'connectors',
  {
    method: 'get',
    path: '/{type}',
    summary: 'Get a connector type',
    params: z.object({ type: z.string() }),
    response: ConnectorInfoSchema,
  },
  (c: C) => {
    const def = connectors.get((valid(c, 'param') as { type: string }).type);
    if (!def) throw new NotFoundError('Connector type not found.', 'CONNECTOR_NOT_FOUND');
    return c.json(connectorInfo(def));
  },
);

/** /hooks/connections: signed inbound webhooks, no session. */
export const hooksRoutes = createRouter();
guard(
  hooksRoutes,
  rateLimit('RL_WEBHOOK', (c) => `${c.req.path}:${clientIp(c)}`),
);
register(
  hooksRoutes,
  'connections',
  {
    method: 'post',
    path: '/connections/{id}',
    summary: 'Inbound webhook (signature verified)',
    params: IdParamSchema,
    status: 202,
    response: WebhookAckSchema,
  },
  async (c: C) => {
    await receiveWebhook(sctx(c), (valid(c, 'param') as { id: string }).id, c.req.raw);
    return c.json({ accepted: true as const }, 202);
  },
);
