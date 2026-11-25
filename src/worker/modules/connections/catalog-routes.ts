import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ConnectorInfoSchema,
  ConnectorListSchema,
  CursorQuerySchema,
  IdSchema,
} from '../../../shared/contracts/index.ts';
import { connectors } from '../../connectors/registry.ts';
import type { AnyConnector } from '../../connectors/types.ts';
import type { AppBindings } from '../../platform/context.ts';
import { type Entitlements, entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { authorityDenied, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { orgIdOf, requireTenantSessionOrApiKey } from '../passes/http.ts';
import { authorizeConnection } from './access.ts';
import { connectorInfo } from './dto.ts';

const ConnectionOrgQuerySchema = z.object({ orgId: IdSchema.optional() });

/** Authorizes the read; returns the org whose plan filters the catalog, or undefined for a platform admin. */
async function authorizeCatalog(
  c: Context<AppBindings>,
  named: string | undefined,
): Promise<string | undefined> {
  // An org key acts in its own org; a session admin without an org reads the platform catalog.
  const auth = c.var.auth;
  const orgId = auth?.kind === 'api_key' ? orgIdOf(auth, named) : named;
  if (orgId !== undefined) {
    await authorizeConnection(serviceContext(c), c.var.auth, orgId, 'integrations:read');
    return orgId;
  }
  if (c.var.auth?.kind === 'session' && c.var.auth.roles.includes('admin')) return undefined;
  throw new ValidationError('Invalid request.', [
    { path: 'orgId', message: 'Required', code: 'invalid_type' },
  ]);
}

/**
 * The connector as the org's plan allows it. A connector with recipes also runs with none (`type/custom`);
 * it lists only the entitled recipes, and drops out when neither that nor any recipe is. Null when out.
 */
function planned(e: Entitlements, def: AnyConnector): z.infer<typeof ConnectorInfoSchema> | null {
  const info = connectorInfo(def);
  if (info.recipes.length === 0) return isEntitled(e, 'connectors', def.type) ? info : null;
  const recipes = info.recipes.filter((r) => isEntitled(e, 'connectors', `${def.type}/${r.id}`));
  return recipes.length > 0 || isEntitled(e, 'connectors', `${def.type}/custom`)
    ? { ...info, recipes }
    : null;
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
      query: ConnectionOrgQuerySchema.extend(CursorQuerySchema.shape),
      response: ConnectorListSchema,
    },
    async (c) => {
      const orgId = await authorizeCatalog(c, c.req.valid('query').orgId);
      if (orgId === undefined)
        return c.json({ items: connectors.list().map(connectorInfo), nextCursor: null });
      const e = await entitlementsOf(serviceContext(c), orgId);
      const items = connectors.list().flatMap((def) => planned(e, def) ?? []);
      return c.json({ items, nextCursor: null });
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
      const orgId = await authorizeCatalog(c, c.req.valid('query').orgId);
      const def = connectors.get(c.req.valid('param').type);
      if (!def) throw new NotFoundError('Connector type not found.', 'CONNECTOR_NOT_FOUND');
      if (orgId === undefined) return c.json(connectorInfo(def));
      const info = planned(await entitlementsOf(serviceContext(c), orgId), def);
      if (!info) throw authorityDenied('entitlement');
      return c.json(info);
    },
  );
}
