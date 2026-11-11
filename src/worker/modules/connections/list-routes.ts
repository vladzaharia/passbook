import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  ConnectionListQuerySchema,
  ConnectionListSchema,
  ConnectionsSummarySchema,
  IdSchema,
} from '../../../shared/contracts/index.ts';
import { assertOrgAccess, modeOf } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ValidationError } from '../../platform/errors.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { authorizeConnection } from './access.ts';
import * as actions from './actions.ts';
import * as service from './service.ts';

type C = Context<AppBindings>;
const ConnectionOrgQuerySchema = z.object({ orgId: IdSchema.optional() });

/** Lists are always scoped; only an org-bound key may omit the organization. */
function connectionListOrg(c: C, requestedOrgId: string | undefined): string {
  const auth = c.var.auth;
  if (auth?.kind === 'api_key' && auth.orgId !== null) {
    if (requestedOrgId !== undefined) assertOrgAccess(auth, requestedOrgId);
    return auth.orgId;
  }
  if (requestedOrgId === undefined) {
    throw new ValidationError('Invalid request.', [
      { path: 'orgId', message: 'Required', code: 'invalid_type' },
    ]);
  }
  return requestedOrgId;
}

export function registerConnectionListRoutes(router: OpenAPIHono<AppBindings>): void {
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/',
      summary: 'List connections',
      query: ConnectionListQuerySchema,
      response: ConnectionListSchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const query = c.req.valid('query');
      const orgId = connectionListOrg(c, query.orgId);
      await authorizeConnection(ctx, c.var.auth, orgId, 'integrations:read');
      if (modeOf(c.var.auth) === 'test') return c.json({ items: [], nextCursor: null });
      return c.json(await service.listAll(ctx, { ...query, orgId }));
    },
  );
  register(
    router,
    'connections',
    {
      method: 'get',
      path: '/summary',
      summary: 'Connection health summary',
      query: ConnectionOrgQuerySchema,
      response: ConnectionsSummarySchema,
    },
    async (c) => {
      const ctx = serviceContext(c);
      const orgId = connectionListOrg(c, c.req.valid('query').orgId);
      await authorizeConnection(ctx, c.var.auth, orgId, 'integrations:read');
      return c.json(
        modeOf(c.var.auth) === 'test'
          ? { total: 0, byHealth: {}, attention: [] }
          : await actions.healthSummary(ctx, orgId),
      );
    },
  );
}
