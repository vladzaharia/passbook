import type { OpenAPIHono } from '@hono/zod-openapi';
import { ConnectionPreviewSchema, IdParamSchema } from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredConnection } from './access.ts';
import { previewSync } from './preview.ts';
import * as service from './service.ts';

/** POST /connections/{id}/preview: what the next sync would do, without doing it. */
export function registerConnectionPreviewRoute(router: OpenAPIHono<AppBindings>): void {
  router.use(
    '/:id/preview',
    rateLimit('RL_API_KEY', (c) => `connection-preview:${actorOf(c.var.auth).id ?? clientIp(c)}`),
  );
  register(
    router,
    'connections',
    {
      method: 'post',
      path: '/{id}/preview',
      summary: 'Preview a sync',
      params: IdParamSchema,
      response: ConnectionPreviewSchema,
    },
    async (c) => {
      // Stored connections have no Test environment; do not expose Live data in Test.
      if (modeOf(c.var.auth) !== 'live')
        throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
      const ctx = serviceContext(c);
      const { id } = c.req.valid('param');
      const conn = await service.requireConnection(ctx, id);
      const authority = await authorizeStoredConnection(
        ctx,
        c.var.auth,
        conn.orgId,
        'integrations:manage',
      );
      return c.json(await previewSync(ctx, id, authority));
    },
  );
}
