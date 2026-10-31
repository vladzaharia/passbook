import { StatusResponseSchema, WorkflowRunListSchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const statusRoutes = createRouter();
guard(statusRoutes, requireAdmin);
stub(statusRoutes, 'status', {
  method: 'get',
  path: '/',
  summary: 'Component health',
  response: StatusResponseSchema,
});
stub(statusRoutes, 'status', {
  method: 'get',
  path: '/workflows',
  summary: 'Recent workflow runs',
  response: WorkflowRunListSchema,
});
