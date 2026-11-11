import type { OpenAPIHono } from '@hono/zod-openapi';
import { IdParamSchema, WebhookAckSchema } from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { guard, register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { receiveWebhook } from './webhooks.ts';

/** Signed inbound webhooks have no session. */
export function registerConnectionWebhookRoutes(router: OpenAPIHono<AppBindings>): void {
  guard(
    router,
    rateLimit('RL_WEBHOOK', (c) => `${c.req.path}:${clientIp(c)}`),
  );
  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/connections/{id}',
      summary: 'Inbound webhook (signature verified)',
      params: IdParamSchema,
      status: 202,
      response: WebhookAckSchema,
    },
    async (c) => {
      await receiveWebhook(serviceContext(c), c.req.valid('param').id, c.req.raw);
      return c.json({ accepted: true as const }, 202);
    },
  );
}
