import type { Context } from 'hono';
import {
  StatusQuerySchema,
  StatusResponseSchema,
  WorkflowRunListSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { valid } from '../audit/http.ts';
import { getStatus, listWorkflowRuns } from './service.ts';

export const statusRoutes = createRouter();
guard(statusRoutes, requireAdmin);

register(
  statusRoutes,
  'status',
  {
    method: 'get',
    path: '/',
    summary: 'Component health',
    query: StatusQuerySchema,
    response: StatusResponseSchema,
  },
  async (c: Context<AppBindings>) => {
    const { fresh } = valid<{ fresh?: '0' | '1' }>(c, 'query');
    return c.json(await getStatus(serviceContext(c), { fresh: fresh === '1' }));
  },
);
register(
  statusRoutes,
  'status',
  {
    method: 'get',
    path: '/workflows',
    summary: 'Recent workflow runs',
    response: WorkflowRunListSchema,
  },
  async (c: Context<AppBindings>) => c.json(await listWorkflowRuns(serviceContext(c))),
);
