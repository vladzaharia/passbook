import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  ConnectionPreviewRequestSchema,
  ConnectionPreviewSchema,
  IdParamSchema,
} from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { actorOf } from '../../platform/context.ts';
import { ForbiddenError, NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { clientIp, rateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey, tenantAuthorityOf } from '../passes/http.ts';
import { authorizeStoredConnection } from './access.ts';
import { previewSync } from './preview.ts';
import { previewArrival } from './preview-arrival.ts';
import * as service from './service.ts';

async function requirePassRead(
  ctx: ReturnType<typeof serviceContext>,
  auth: AppBindings['Variables']['auth'],
  orgId: string,
): Promise<void> {
  if (auth?.kind === 'api_key') {
    if (!auth.scopes.includes('passes:read'))
      throw new ForbiddenError('The API key lacks the passes:read scope.', 'MISSING_SCOPE');
    return;
  }
  if (auth) await tenantAuthorityOf(ctx, auth, orgId, 'passes:read');
}

/**
 * POST /connections/{id}/preview: what the next sync would do, without doing it. It reads, so it needs
 * connections:read and passes:read (a session: integrations:read and passes:read), not the write scope
 * the router's other POSTs take. Register it before the router-wide guard.
 */
export function registerConnectionPreviewRoute(router: OpenAPIHono<AppBindings>): void {
  router.use('/:id/preview', requireTenantSessionOrApiKey('connections:read'));
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
      summary: 'Preview a sync, or what one received webhook made',
      params: IdParamSchema,
      body: ConnectionPreviewRequestSchema,
      bodyOptional: true,
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
        'integrations:read',
      );
      await requirePassRead(ctx, c.var.auth, conn.orgId);
      const arrivalId = (c.req.valid('json') as { arrivalId?: string } | undefined)?.arrivalId;
      return c.json(
        arrivalId
          ? await previewArrival(ctx, id, arrivalId, authority)
          : await previewSync(ctx, id, authority),
      );
    },
  );
}
