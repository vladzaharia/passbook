import {
  DeveloperFunnelSchema,
  IdSchema,
  MetricsOverviewSchema,
  MetricsQuerySchema,
  OrgActivitySchema,
} from '../../../shared/contracts/index.ts';
import {
  type AuthContext,
  modeFromRequest,
  modeOf,
  requireAdmin,
  requireConsoleSession,
} from '../../platform/auth.ts';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess } from '../orgs/access.ts';
import { requireNotPersonalFor } from '../orgs/personal-guard.ts';
import { getOrgActivity } from './activity.ts';
import { developerFunnel } from './developer-funnel.ts';
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
    const auth = c.var.auth;
    if (query.orgId && auth?.kind === 'session')
      await requireNotPersonalFor(ctx.env.DB, query.orgId, auth.userId);
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

register(
  metricsRoutes,
  'metrics',
  {
    method: 'get',
    path: '/platform/developer',
    summary: 'Developer quickstart funnel: sandboxes by step and time to first pass (30 days)',
    auth: { platform: 'platform:status' },
    response: DeveloperFunnelSchema,
  },
  async (c) => c.json(await developerFunnel(serviceContext(c))),
);
