import type { OpenAPIHono } from '@hono/zod-openapi';
import { IdParamSchema } from '../../../shared/contracts/common.ts';
import {
  CaptureEndpointCreatedSchema,
  CaptureSecretSchema,
  CreateCaptureEndpointSchema,
  WebhookCaptureListQuerySchema,
  WebhookCaptureListSchema,
  WebhookCaptureParamSchema,
  WebhookCaptureSchema,
} from '../../../shared/contracts/webhook-captures.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredEndpoint, authorizeWebhooks, webhookOrg } from './access.ts';
import * as captures from './service-captures.ts';

/** Under /webhook-endpoints: the same guard (`webhooks:manage` or a session's integrations capability). */
export function registerCaptureRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'webhooks',
    {
      method: 'post',
      path: '/capture',
      summary: "Get the sandbox's capture endpoint, making it if it has none (secret shown once)",
      body: CreateCaptureEndpointSchema,
      status: 201,
      response: CaptureEndpointCreatedSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const input = c.req.valid('json');
      const org = webhookOrg(c.var.auth, input.orgId);
      const access = await authorizeWebhooks(ctx, c.var.auth, org, 'integrations:manage');
      const { created, ...out } = await captures.ensureCapture(
        ctx,
        actorOf(c.var.auth),
        access,
        input.eventTypes,
      );
      return c.json(out, created ? 201 : 200);
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'get',
      path: '/{id}/captures',
      summary: 'Requests a capture endpoint stored, newest first',
      params: IdParamSchema,
      query: WebhookCaptureListQuerySchema,
      response: WebhookCaptureListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
      return c.json(await captures.list(ctx, access, id, c.req.valid('query')));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'get',
      path: '/{id}/captures/{captureId}',
      summary: 'One stored request: headers and the raw body',
      params: WebhookCaptureParamSchema,
      response: WebhookCaptureSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id, captureId } = c.req.valid('param');
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
      return c.json(await captures.get(ctx, access, id, captureId));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'post',
      path: '/{id}/captures/{captureId}/replay',
      summary: 'Sign a stored request again and store it as a new capture',
      params: WebhookCaptureParamSchema,
      status: 201,
      response: WebhookCaptureSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id, captureId } = c.req.valid('param');
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
      return c.json(await captures.replay(ctx, access, id, captureId), 201);
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'post',
      path: '/{id}/captures/secret',
      summary: "Read a capture endpoint's current signing secret",
      params: IdParamSchema,
      response: CaptureSecretSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
      c.header('cache-control', 'no-store');
      return c.json({ secret: await captures.revealSecret(ctx, actorOf(c.var.auth), access, id) });
    },
  );
}
