import { MetricsOverviewSchema, MetricsQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const metricsRoutes = createRouter();
guard(metricsRoutes, requireAdmin);
stub(metricsRoutes, 'metrics', {
  method: 'get',
  path: '/overview',
  summary: 'Overview metrics',
  query: MetricsQuerySchema,
  response: MetricsOverviewSchema,
});
