import type { Context } from 'hono';
import {
  ConnectionCreatedSchema,
  ConnectionDetailSchema,
  ConnectionRunListSchema,
  ConnectionRunsQuerySchema,
  ConnectionSchema,
  CreateConnectionSchema,
  IdParamSchema,
  OkSchema,
  RotateWebhookSecretQuerySchema,
  SyncNowResponseSchema,
  TestConfigQuerySchema,
  TestConfigResponseSchema,
  TestConfigSchema,
  TestConnectionResponseSchema,
  UpdateConnectionSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, modeOf } from '../../platform/auth.ts';
import { defaultBodyLimit, limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { declareKeyAccess } from '../../platform/openapi-security.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { peekBody, requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection, authorizeStoredConnection as authorizeStored } from './access.ts';
import * as actions from './actions.ts';
import { registerConnectorCatalogRoutes } from './catalog-routes.ts';
import { registerConnectionFileRoutes } from './files-routes.ts';
import { registerConnectionListRoutes } from './list-routes.ts';
import { previewUnsaved } from './preview.ts';
import { registerConnectionPreviewRoute } from './preview-routes.ts';
import { registerConnectionProbeRoutes } from './probe-routes.ts';
import * as service from './service.ts';
import { registerConnectionSetupRoute } from './setup-routes.ts';
import { testConfig } from './test-config.ts';
import { registerWebhookArrivalRoutes } from './webhook-arrivals-routes.ts';
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
export const connectionsRoutes = createRouter({ bodyLimit: false });
// A file upload is JSON with the file inside: base64 of 5 MB plus the envelope.
const UPLOAD_BODY_BYTES = 7 * 1024 * 1024;
connectionsRoutes.use('*', defaultBodyLimit(/\/connections\/(?:uploads|[^/]+\/files)\/?$/));
connectionsRoutes.use('/uploads', limitBody(UPLOAD_BODY_BYTES));
connectionsRoutes.use('/:id/files', limitBody(UPLOAD_BODY_BYTES));
registerConnectionPreviewRoute(connectionsRoutes);
// The preview route (above) takes read scopes on a POST; this guard documents the rest.
guard(
  connectionsRoutes,
  declareKeyAccess(
    requireTenantSessionOrApiKey(
      methodScope({ read: 'connections:read', write: 'connections:write' }),
    ),
    { read: ['connections:read'], write: ['connections:write'], only: /^(?!.*\/preview$)/ },
  ),
);
// A new webhook secret is a credential: a recent sign-in, for a person (not a key).
connectionsRoutes.post('/:id/webhook-secret', requireStepUp(STEP_UP_SECONDS));
// Credentials, the webhook secret, the upstream config and the mode (webhook mode generates a secret) change
// what a connection trusts and reaches; a name, mapping or schedule edit does not ask.
const TRUST_FIELDS = ['secrets', 'webhookSecret', 'overlapSeconds', 'config', 'mode'];
const touchesTrust = async (c: Parameters<typeof peekBody>[0]) => {
  const body = await peekBody(c);
  return TRUST_FIELDS.some((field) => field in body);
};
connectionsRoutes.post('/', requireStepUp(STEP_UP_SECONDS, touchesTrust));
connectionsRoutes.patch('/:id', requireStepUp(STEP_UP_SECONDS, touchesTrust));
registerWebhookRetentionRoutes(connectionsRoutes);
registerWebhookArrivalRoutes(connectionsRoutes);
registerConnectionListRoutes(connectionsRoutes);
registerConnectionSetupRoute(connectionsRoutes);
registerConnectionFileRoutes(connectionsRoutes);
// A probe that brings its own config or secrets reads through the stored credential: it asks what PATCH asks.
connectionsRoutes.post('/:id/probe', requireStepUp(STEP_UP_SECONDS, touchesTrust));
registerConnectionProbeRoutes(connectionsRoutes);
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
    query: TestConfigQuerySchema,
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
    if (c.req.valid('query').preview === 'true')
      return c.json(await previewUnsaved(ctx, input, authority));
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
    return c.json(await actions.syncNowReported(ctx, actor(c), id, authority, c.var.auth), 202);
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
    query: RotateWebhookSecretQuerySchema,
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
      c.req.valid('query').overlapSeconds,
    );
    return c.json({ ...connection, webhookSecret });
  },
);
register(
  connectionsRoutes,
  'connections',
  {
    method: 'delete',
    path: '/{id}/webhook-secret/previous',
    summary: 'Stop accepting the previous webhook secret now',
    params: IdParamSchema,
    response: ConnectionSchema,
  },
  async (c) => {
    assertLive(c);
    const ctx = sctx(c);
    const id = c.req.valid('param').id;
    const authority = await authorizeStoredConnection(c, ctx, id, 'integrations:manage');
    return c.json(await actions.revokePreviousWebhookSecret(ctx, actor(c), id, authority));
  },
);

/** /api/v1/connectors: platform catalog or a tenant-scoped integration catalog. */
export const connectorsRoutes = createRouter();
registerConnectorCatalogRoutes(connectorsRoutes);

/** /hooks/connections: signed inbound webhooks, no session. */
export const hooksRoutes = createRouter();
registerConnectionWebhookRoutes(hooksRoutes);
