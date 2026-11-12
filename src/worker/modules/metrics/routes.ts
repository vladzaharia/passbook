import {
  IdSchema,
  MetricsOverviewSchema,
  MetricsQuerySchema,
} from '../../../shared/contracts/index.ts';
import { modeFromRequest, modeOf, requireAdmin, requireSession } from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { templateUsableByOrg } from './repo.ts';
import { getOverview } from './service.ts';

const TenantMetricsQuerySchema = MetricsQuerySchema.extend({ orgId: IdSchema });

export const metricsRoutes = createRouter();
guard(metricsRoutes, requireSession);
metricsRoutes.use('/platform/*', requireAdmin);
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
    path: '/platform/overview',
    summary: 'Platform overview metrics (filtered results are aggregate-only)',
    query: MetricsQuerySchema,
    response: MetricsOverviewSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    if (
      query.orgId &&
      query.templateId &&
      !(await templateUsableByOrg(ctx.env.DB, query.templateId, query.orgId))
    ) {
      throw new NotFoundError('Metrics not found.', 'METRICS_NOT_FOUND');
    }
    return c.json(await getOverview(ctx, query, modeOf(c.var.auth), 'platform'));
  },
);
