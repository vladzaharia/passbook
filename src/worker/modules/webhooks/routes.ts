import { z } from 'zod';
import {
  CursorQuerySchema,
  IdParamSchema,
  IdSchema,
  OkSchema,
} from '../../../shared/contracts/common.ts';
import { SendTestEventSchema } from '../../../shared/contracts/webhook-captures.ts';
import { RotateWebhookSecretSchema } from '../../../shared/contracts/webhook-secrets.ts';
import {
  CreateWebhookEndpointSchema,
  UpdateWebhookEndpointSchema,
  WebhookEndpointCreatedSchema,
  WebhookEndpointListSchema,
  WebhookEndpointSchema,
  type WebhookEventType,
  WebhookSecretSchema,
  WebhookTestResultSchema,
} from '../../../shared/contracts/webhooks.ts';
import { actorOf } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { peekBody, requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeStoredEndpoint, authorizeWebhooks, webhookOrg } from './access.ts';
import { registerCaptureRoutes } from './routes-captures.ts';
import { registerDeliveryRoutes } from './routes-deliveries.ts';
import * as service from './service.ts';
import * as secrets from './service-secrets.ts';
import * as test from './service-test.ts';

const OrgQuerySchema = z.object({ orgId: IdSchema.optional() });
const CreateQuerySchema = z.object({ validate: z.literal('1').optional() });

/**
 * /api/v1/webhook-endpoints. A key needs `webhooks:manage` (not `connections:*`); a session needs
 * `integrations:read` to view and `integrations:manage` to change, through its membership.
 */
export const webhookEndpointsRoutes = createRouter();
guard(webhookEndpointsRoutes, requireTenantSessionOrApiKey(['webhooks:manage']));
// Rotating or reading a signing secret hands over a credential: a recent sign-in, for a person (not a key).
webhookEndpointsRoutes.post('/:id/secret', requireStepUp(STEP_UP_SECONDS));
webhookEndpointsRoutes.post('/:id/captures/secret', requireStepUp(STEP_UP_SECONDS));
// A new endpoint, or an existing one pointed elsewhere or at other events, sends the event stream out.
webhookEndpointsRoutes.post('/', requireStepUp(STEP_UP_SECONDS));
webhookEndpointsRoutes.patch(
  '/:id',
  requireStepUp(STEP_UP_SECONDS, async (c) => {
    const body = await peekBody(c);
    return 'url' in body || 'eventTypes' in body;
  }),
);

register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'get',
    path: '/',
    summary: 'List webhook endpoints',
    query: OrgQuerySchema.extend(CursorQuerySchema.shape),
    response: WebhookEndpointListSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const org = webhookOrg(c.var.auth, c.req.valid('query').orgId);
    const access = await authorizeWebhooks(ctx, c.var.auth, org, 'integrations:read');
    return c.json(await service.list(ctx, access));
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'post',
    path: '/',
    summary: 'Create a webhook endpoint (secret shown once; ?validate=1 writes nothing)',
    query: CreateQuerySchema,
    body: CreateWebhookEndpointSchema,
    status: 201,
    response: WebhookEndpointCreatedSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const input = c.req.valid('json');
    const org = webhookOrg(c.var.auth, input.orgId);
    const access = await authorizeWebhooks(ctx, c.var.auth, org, 'integrations:manage');
    const dryRun = c.req.valid('query').validate === '1';
    const created = await service.create(ctx, actorOf(c.var.auth), access, input, dryRun);
    return created ? c.json(created, 201) : c.json({ ok: true as const });
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Webhook endpoint',
    params: IdParamSchema,
    response: WebhookEndpointSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
    return c.json(await service.get(ctx, access, id));
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update, pause or resume a webhook endpoint',
    params: IdParamSchema,
    body: UpdateWebhookEndpointSchema,
    response: WebhookEndpointSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
    return c.json(await service.update(ctx, actorOf(c.var.auth), access, id, c.req.valid('json')));
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete a webhook endpoint',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
    await service.remove(ctx, actorOf(c.var.auth), access, id);
    return c.json({ ok: true as const });
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'post',
    path: '/{id}/secret',
    summary: 'Rotate the signing secret (shown once)',
    params: IdParamSchema,
    body: RotateWebhookSecretSchema,
    response: WebhookSecretSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
    const { overlapHours } = c.req.valid('json');
    return c.json(await secrets.rotate(ctx, actorOf(c.var.auth), access, id, overlapHours));
  },
);
register(
  webhookEndpointsRoutes,
  'webhooks',
  {
    method: 'post',
    path: '/{id}/test',
    summary: 'Send a test event to this endpoint (any type; a sample for all but webhook.test)',
    params: IdParamSchema,
    body: SendTestEventSchema,
    bodyOptional: true,
    response: WebhookTestResultSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
    // No body, no type: the older `webhook.test` call keeps working.
    const type = (c.req.valid('json') as { type?: WebhookEventType } | undefined)?.type;
    return c.json(await test.sendTest(ctx, actorOf(c.var.auth), access, id, type));
  },
);
registerCaptureRoutes(webhookEndpointsRoutes);
registerDeliveryRoutes(webhookEndpointsRoutes);
