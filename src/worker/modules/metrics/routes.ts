import type { Context } from 'hono';
import { MetricsOverviewSchema, MetricsQuerySchema } from '../../../shared/contracts/index.ts';
import type { MetricsQuery } from '../../../shared/contracts/metrics.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { valid } from '../audit/http.ts';
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
  async (c: Context<AppBindings>) =>
    c.json(await getOverview(serviceContext(c), valid<MetricsQuery>(c, 'query'))),
);
