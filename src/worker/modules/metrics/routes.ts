import { MetricsOverviewSchema, MetricsQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getOverview } from './service.ts';

export const metricsRoutes = createRouter();
guard(metricsRoutes, requireAdmin);

register(
  metricsRoutes,
  'metrics',
  {
    method: 'get',
    path: '/overview',
    summary: 'Overview metrics',
    query: MetricsQuerySchema,
    response: MetricsOverviewSchema,
  },
  async (c) => c.json(await getOverview(serviceContext(c), c.req.valid('query'))),
);
