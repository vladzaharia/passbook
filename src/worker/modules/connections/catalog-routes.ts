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
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
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
 * The connector with the org's plan applied: `entitled` on it (a sender: running with no recipe, which is
 * `type/custom`) and on each recipe. Nothing is removed, so a detail page still opens for a connection the
 * plan no longer includes.
 */
function flagged(e: Entitlements, def: AnyConnector): z.infer<typeof ConnectorInfoSchema> {
  const info = connectorInfo(def);
  const allowed = (item: string) => isEntitled(e, 'connectors', item);
  if (info.recipes.length === 0) return { ...info, entitled: allowed(def.type) };
  return {
    ...info,
    entitled: allowed(`${def.type}/custom`),
    recipes: info.recipes.map((r) => ({ ...r, entitled: allowed(`${def.type}/${r.id}`) })),
  };
}

/** The list shows only what the plan allows: entitled recipes, and a connector only when something of it is. */
function listed(info: z.infer<typeof ConnectorInfoSchema>): z.infer<typeof ConnectorInfoSchema>[] {
  const recipes = info.recipes.filter((r) => r.entitled);
  return info.entitled || recipes.length > 0 ? [{ ...info, recipes }] : [];
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
      const items = connectors.list().flatMap((def) => listed(flagged(e, def)));
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
      return c.json(flagged(await entitlementsOf(serviceContext(c), orgId), def));
    },
  );
}
