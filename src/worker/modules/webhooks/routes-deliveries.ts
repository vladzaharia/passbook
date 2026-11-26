import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import { IdParamSchema, IdSchema } from '../../../shared/contracts/common.ts';
import { WebhookDeliveryListQuerySchema } from '../../../shared/contracts/webhook-captures.ts';
import { WebhookTestAttemptListSchema } from '../../../shared/contracts/webhook-tests.ts';
import {
  WebhookDeliveryDetailSchema,
  WebhookDeliveryListSchema,
  WebhookReplayResultSchema,
  WebhookReplaySchema,
} from '../../../shared/contracts/webhooks.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredEndpoint } from './access.ts';
import * as replay from './service-replay.ts';
import { listTests } from './service-test.ts';

const DeliveryParamSchema = z.object({ id: IdSchema, eventId: IdSchema });

export function registerDeliveryRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'webhooks',
    {
      method: 'get',
      path: '/{id}/deliveries',
      summary: 'Deliveries of an endpoint, newest first',
      params: IdParamSchema,
      query: WebhookDeliveryListQuerySchema,
      response: WebhookDeliveryListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
      return c.json(await replay.deliveries(ctx, access, id, c.req.valid('query')));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'get',
      path: '/{id}/tests',
      summary: 'Recent test sends of an endpoint, newest first',
      params: IdParamSchema,
      response: WebhookTestAttemptListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
      return c.json(await listTests(ctx, access, id));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'get',
      path: '/{id}/deliveries/{eventId}',
      summary: 'One delivery with its attempts and payload',
      params: DeliveryParamSchema,
      response: WebhookDeliveryDetailSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id, eventId } = c.req.valid('param');
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:read');
      return c.json(await replay.deliveryDetail(ctx, access, id, eventId));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'post',
      path: '/{id}/deliveries/{eventId}/replay',
      summary: 'Send one delivery again',
      params: DeliveryParamSchema,
      response: WebhookReplayResultSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const { id, eventId } = c.req.valid('param');
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
      return c.json(await replay.replayDelivery(ctx, actorOf(c.var.auth), access, id, eventId));
    },
  );
  register(
    router,
    'webhooks',
    {
      method: 'post',
      path: '/{id}/replay',
      summary: 'Send many deliveries again, by event time',
      params: IdParamSchema,
      body: WebhookReplaySchema,
      response: WebhookReplayResultSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const id = c.req.valid('param').id;
      const access = await authorizeStoredEndpoint(ctx, c.var.auth, id, 'integrations:manage');
      return c.json(
        await replay.replayRange(ctx, actorOf(c.var.auth), access, id, c.req.valid('json')),
      );
    },
  );
}
