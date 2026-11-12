import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  IdParamSchema,
  IdSchema,
  OkSchema,
  ResolveWebhookFailureResponseSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredConnection } from './access.ts';
import * as service from './service.ts';
import { listRetainedWebhooks, replayRetainedWebhook } from './webhook-replay.ts';
import { resolveUncertainWebhook } from './webhook-resolve.ts';

const RetentionParamsSchema = IdParamSchema.extend({ retentionId: IdSchema });
const RetainedWebhookListSchema = z.object({
  items: z.array(
    z.object({
      id: IdSchema,
      eventRef: z.string(),
      generation: z.number().int().positive(),
      connectionMode: z.enum(['webhook', 'hybrid', 'unknown']),
      state: z.enum(['pending', 'failed', 'blocked', 'resolved', 'ignored']),
      errorCode: z.string().nullable(),
      /** Items whose effect is unknown; the operator resolves them after checking the source. */
      uncertainItems: z.number().int().nonnegative(),
      receivedAt: z.number(),
      updatedAt: z.number(),
    }),
  ),
});

function assertLive(c: Context<AppBindings>): void {
  if (modeOf(c.var.auth) !== 'live') {
    throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
  }
}

export function registerWebhookRetentionRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/{id}/webhook-failures',
      summary: 'List retained webhook status',
      params: IdParamSchema,
      response: RetainedWebhookListSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const connection = await service.requireConnection(ctx, id);
      await authorizeStoredConnection(ctx, c.var.auth, connection.orgId, 'integrations:read');
      const result = await listRetainedWebhooks(ctx, id);
      return c.json({
        items: result.items.map(
          ({
            id,
            eventRef,
            generation,
            connectionMode,
            state,
            errorCode,
            uncertainItems,
            receivedAt,
            updatedAt,
          }) => ({
            id,
            eventRef,
            generation,
            connectionMode,
            state,
            errorCode,
            uncertainItems,
            receivedAt,
            updatedAt,
          }),
        ),
      });
    },
  );

  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/{id}/webhook-failures/{retentionId}/replay',
      summary: 'Replay a retained webhook',
      params: RetentionParamsSchema,
      status: 202,
      response: OkSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const { id, retentionId } = c.req.valid('param');
      const connection = await service.requireConnection(ctx, id);
      const authority = await authorizeStoredConnection(
        ctx,
        c.var.auth,
        connection.orgId,
        'integrations:manage',
      );
      await replayRetainedWebhook(ctx, id, retentionId, authority);
      return c.json({ ok: true as const }, 202);
    },
  );

  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/{id}/webhook-failures/{retentionId}/resolve',
      summary: 'Mark an uncertain webhook resolved after checking the source system',
      params: RetentionParamsSchema,
      response: ResolveWebhookFailureResponseSchema,
    },
    async (c) => {
      assertLive(c);
      const ctx = serviceContext(c);
      const { id, retentionId } = c.req.valid('param');
      const connection = await service.requireConnection(ctx, id);
      const authority = await authorizeStoredConnection(
        ctx,
        c.var.auth,
        connection.orgId,
        'integrations:manage',
      );
      const result = await resolveUncertainWebhook(
        ctx,
        actorOf(c.var.auth),
        id,
        retentionId,
        authority,
      );
      return c.json({ ok: true as const, ...result });
    },
  );
}
