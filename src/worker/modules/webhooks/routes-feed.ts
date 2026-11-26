import { z } from 'zod';
import { IdSchema } from '../../../shared/contracts/common.ts';
import {
  EventFeedPageSchema,
  EventFeedQuerySchema,
  WebhookEventSchema,
} from '../../../shared/contracts/webhooks.ts';
import { EventDeliveriesSchema } from '../../../shared/contracts/workbench-read.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeFeed, webhookOrg } from './access.ts';
import * as feed from './service-feed.ts';

const EventParamSchema = z.object({ id: IdSchema });
const EventQuerySchema = EventFeedQuerySchema.pick({ orgId: true, apiVersion: true });

/** /api/v1/events: the same events the webhooks carry, for a poller. `passes:read` for both. */
export const eventFeedRoutes = createRouter();
guard(eventFeedRoutes, requireTenantSessionOrApiKey(['passes:read']));

register(
  eventFeedRoutes,
  'events',
  {
    method: 'get',
    path: '/',
    summary: 'Event feed (cursor paging, ascending)',
    query: EventFeedQuerySchema,
    response: EventFeedPageSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const q = c.req.valid('query');
    const access = await authorizeFeed(ctx, c.var.auth, webhookOrg(c.var.auth, q.orgId));
    return c.json(await feed.page(ctx, access, q));
  },
);
register(
  eventFeedRoutes,
  'events',
  {
    method: 'get',
    path: '/{id}',
    summary: 'One event by id',
    params: EventParamSchema,
    query: EventQuerySchema,
    response: WebhookEventSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const q = c.req.valid('query');
    const access = await authorizeFeed(ctx, c.var.auth, webhookOrg(c.var.auth, q.orgId));
    return c.json(await feed.one(ctx, access, c.req.valid('param').id, q.apiVersion));
  },
);
register(
  eventFeedRoutes,
  'events',
  {
    method: 'get',
    path: '/{id}/deliveries',
    summary:
      'Where one event was sent: its deliveries across endpoints. `passes:read`, like the event',
    params: EventParamSchema,
    query: EventQuerySchema.pick({ orgId: true }),
    response: EventDeliveriesSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const access = await authorizeFeed(
      ctx,
      c.var.auth,
      webhookOrg(c.var.auth, c.req.valid('query').orgId),
    );
    return c.json(await feed.deliveriesOf(ctx, access, c.req.valid('param').id));
  },
);
