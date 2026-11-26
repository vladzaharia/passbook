import type { OpenAPIHono } from '@hono/zod-openapi';
import { ConnectionSetupSchema, IdParamSchema } from '../../../shared/contracts/index.ts';
import { modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeStoredConnection } from './access.ts';
import { connectionSetup } from './setup.ts';

export function registerConnectionSetupRoute(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/{id}/setup',
      summary: "A webhook connection's setup guide with its URL filled in; never the secret",
      params: IdParamSchema,
      response: ConnectionSetupSchema,
    },
    async (c) => {
      if (modeOf(c.var.auth) !== 'live') {
        throw new NotFoundError('Connection not found.', 'CONNECTION_NOT_FOUND');
      }
      const ctx = serviceContext(c);
      return c.json(
        await connectionSetup(ctx, c.req.valid('param').id, (orgId) =>
          authorizeStoredConnection(ctx, c.var.auth, orgId, 'integrations:read'),
        ),
      );
    },
  );
}
