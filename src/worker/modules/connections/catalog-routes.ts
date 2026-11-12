import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ConnectorInfoSchema,
  ConnectorListSchema,
  IdSchema,
} from '../../../shared/contracts/index.ts';
import { connectors } from '../../connectors/registry.ts';
import type { AppBindings } from '../../platform/context.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import { guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection } from './access.ts';
import { connectorInfo } from './dto.ts';

const ConnectionOrgQuerySchema = z.object({ orgId: IdSchema.optional() });

async function authorizeCatalog(c: Context<AppBindings>, orgId: string | undefined): Promise<void> {
  if (orgId !== undefined) {
    await authorizeConnection(serviceContext(c), c.var.auth, orgId, 'integrations:read');
    return;
  }
  if (c.var.auth?.kind === 'session' && c.var.auth.roles.includes('admin')) return;
  throw new ValidationError('Invalid request.', [
    { path: 'orgId', message: 'Required', code: 'invalid_type' },
  ]);
}

/** Platform catalog or a tenant-scoped integration catalog. */
export function registerConnectorCatalogRoutes(router: OpenAPIHono<AppBindings>): void {
  guard(router, requireTenantSessionOrApiKey('connections:read'));
  register(
    router,
    'connectors',
    {
      method: 'get',
      path: '/',
      summary: 'List connector types',
      query: ConnectionOrgQuerySchema,
      response: ConnectorListSchema,
    },
    async (c) => {
      await authorizeCatalog(c, c.req.valid('query').orgId);
      return c.json({ items: connectors.list().map(connectorInfo) });
    },
  );
  register(
    router,
    'connectors',
    {
      method: 'get',
      path: '/{type}',
      summary: 'Get a connector type',
      params: z.object({ type: z.string() }),
      query: ConnectionOrgQuerySchema,
      response: ConnectorInfoSchema,
    },
    async (c) => {
      await authorizeCatalog(c, c.req.valid('query').orgId);
      const def = connectors.get(c.req.valid('param').type);
      if (!def) throw new NotFoundError('Connector type not found.', 'CONNECTOR_NOT_FOUND');
      return c.json(connectorInfo(def));
    },
  );
}
