import {
  DeveloperFunnelSchema,
  MetricsOverviewSchema,
  MetricsQuerySchema,
} from '../../../shared/contracts/index.ts';
import { platformActorOf } from '../../platform/actor.ts';
import { modeOf } from '../../platform/auth.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireNotPersonalFor } from '../orgs/personal-guard.ts';
import { developerFunnel } from './developer-funnel.ts';
import { templateUsableByOrg } from './repo.ts';
import { getOverview } from './service.ts';

/** Mount at /api/v1/metrics before `metricsRoutes`, whose console guard would turn a Bearer key away. */
export const metricsPlatformRoutes = createRouter();

register(
  metricsPlatformRoutes,
  'metrics',
  {
    method: 'get',
    auth: { platform: 'platform:status', key: true },
    path: '/platform/overview',
    summary: 'Platform overview metrics (filtered results are aggregate-only)',
    query: MetricsQuerySchema,
    response: MetricsOverviewSchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    // A key is nobody's owner: no personal org's metrics, ever.
    if (query.orgId)
      await requireNotPersonalFor(ctx.env.DB, query.orgId, platformActorOf(c).userId ?? '');
    if (
      query.orgId &&
      query.templateId &&
      !(await templateUsableByOrg(ctx.env.DB, query.templateId, query.orgId))
    ) {
      throw new NotFoundError('Metrics not found.', 'METRICS_NOT_FOUND');
    }
    return c.json(
      await getOverview(ctx, query, modeOf(c.var.auth), 'platform', c.var.auth?.kind !== 'session'),
    );
  },
);

register(
  metricsPlatformRoutes,
  'metrics',
  {
    method: 'get',
    path: '/platform/developer',
    summary: 'Developer quickstart funnel: sandboxes by step and time to first pass (30 days)',
    auth: { platform: 'platform:status', key: true },
    response: DeveloperFunnelSchema,
  },
  async (c) => c.json(await developerFunnel(serviceContext(c))),
);
