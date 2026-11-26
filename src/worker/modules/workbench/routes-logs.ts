import {
  IdParamSchema,
  OrgRequestLogQuerySchema,
  RequestLogDetailSchema,
  RequestLogPageSchema,
} from '../../../shared/contracts/index.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgRequestLog, listOrgRequestLog } from '../developer/request-log-service.ts';
import { authOf, orgIdOf, tenantAuthorityOf } from '../passes/http.ts';

const READ = { scope: 'logs:read', capability: 'logs:read' } as const;

/**
 * Mount at /api/v1/request-logs. An org's Test calls, 7 days (bodies 24 hours where the org records them). A
 * member holding `logs:read` names the org with `orgId`; a Test key holding the scope reads its own org's.
 */
export const requestLogRoutes = createRouter();
requestLogRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

register(
  requestLogRoutes,
  'workbench',
  {
    method: 'get',
    path: '/',
    operationId: 'workbench.listRequestLogs',
    summary: "List an organization's Test calls, newest first",
    auth: READ,
    query: OrgRequestLogQuerySchema,
    response: RequestLogPageSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const { orgId: named, ...query } = c.req.valid('query');
    const orgId = orgIdOf(authOf(c), named);
    await tenantAuthorityOf(ctx, authOf(c), orgId, 'logs:read');
    return c.json(await listOrgRequestLog(ctx, orgId, query));
  },
);

register(
  requestLogRoutes,
  'workbench',
  {
    method: 'get',
    path: '/{id}',
    operationId: 'workbench.getRequestLog',
    summary:
      'One Test call, with its redacted bodies for 24 hours where the organization records them',
    auth: READ,
    params: IdParamSchema,
    query: OrgRequestLogQuerySchema.pick({ orgId: true }),
    response: RequestLogDetailSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const orgId = orgIdOf(authOf(c), c.req.valid('query').orgId);
    await tenantAuthorityOf(ctx, authOf(c), orgId, 'logs:read');
    return c.json(await getOrgRequestLog(ctx, orgId, c.req.valid('param').id));
  },
);
