import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ArrivalListQuerySchema,
  ArrivalListSchema,
  IdParamSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredConnection } from './access.ts';
import * as service from './service.ts';
import { connectionArrivals } from './webhook-arrivals.ts';

/** GET /connections/{id}/webhook-arrivals: what the ingress saw, newest first, for the setup wizard. */
export function registerWebhookArrivalRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/{id}/webhook-arrivals',
      summary: 'List webhook arrivals',
      params: IdParamSchema,
      query: ArrivalListQuerySchema,
      response: ArrivalListSchema,
    },
    async (c) => {
      if (modeOf(c.var.auth) !== 'live') {
        throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
      }
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const connection = await service.requireConnection(ctx, id);
      await authorizeStoredConnection(ctx, c.var.auth, connection.orgId, 'integrations:read');
      const items = await connectionArrivals(ctx, id, c.req.valid('query'));
      const etag = `W/"${items.length}:${items[0]?.lastAt ?? 0}:${items.reduce((n, r) => n + r.count, 0)}"`;
      if (c.req.header('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      c.header('etag', etag);
      return c.json({ items, nextCursor: null });
    },
  );
}
