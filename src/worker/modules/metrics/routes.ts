import {
  IdSchema,
  MetricsOverviewSchema,
  MetricsQuerySchema,
  OrgActivitySchema,
} from '../../../shared/contracts/index.ts';
import { type AuthContext, modeFromRequest, requireConsoleSession } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { getOrgActivity } from './activity.ts';
import { templateUsableByOrg } from './repo.ts';
import { getOverview } from './service.ts';

const TenantMetricsQuerySchema = MetricsQuerySchema.extend({ orgId: IdSchema });

/** Tenant metrics are for readers of the org and its passes; anything else is not found. */
async function requireMetricsReader(
  ctx: ReturnType<typeof serviceContext>,
  auth: AuthContext | undefined,
  orgId: string,
): Promise<void> {
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const membership = await getOrgAccess(ctx, auth.userId, orgId).catch((error: unknown) => {
    if (error instanceof ForbiddenError) return null;
    throw error;
  });
  if (
    !membership?.capabilities.includes('org:read') ||
    !membership.capabilities.includes('passes:read')
  ) {
    throw new NotFoundError('Metrics not found.', 'METRICS_NOT_FOUND');
  }
}

export const metricsRoutes = createRouter();
guard(metricsRoutes, requireConsoleSession);
register(
  metricsRoutes,
  'metrics',
  {
    method: 'get',
    path: '/overview',
    summary: 'Organization overview metrics',
    query: TenantMetricsQuerySchema,
    response: MetricsOverviewSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const membership = await getOrgAccess(ctx, auth.userId, query.orgId).catch((error: unknown) => {
      if (error instanceof ForbiddenError) return null;
      throw error;
    });
    if (
      !membership?.capabilities.includes('org:read') ||
      !membership.capabilities.includes('passes:read')
    ) {
      throw new NotFoundError('Metrics not found.', 'METRICS_NOT_FOUND');
    }
    if (
      query.templateId &&
      !(await templateUsableByOrg(ctx.env.DB, query.templateId, query.orgId))
    ) {
      throw new NotFoundError('Metrics not found.', 'METRICS_NOT_FOUND');
    }
    return c.json(await getOverview(ctx, query, modeFromRequest(c), 'tenant'));
  },
);

register(
  metricsRoutes,
  'metrics',
  {
    method: 'get',
    path: '/activity',
    summary: 'Organization activity by template',
    query: MetricsQuerySchema.extend({ orgId: IdSchema }).omit({ templateId: true }),
    response: OrgActivitySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    await requireMetricsReader(ctx, c.var.auth, query.orgId);
    return c.json(await getOrgActivity(ctx, query, modeFromRequest(c)));
  },
);
