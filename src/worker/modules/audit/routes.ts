import type { Context } from 'hono';
import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { valid } from './http.ts';
import { listAudit } from './service.ts';

export const auditRoutes = createRouter();
guard(auditRoutes, requireAdmin);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/',
    summary: 'Query the audit log',
    query: AuditQuerySchema,
    response: AuditListSchema,
  },
  async (c: Context<AppBindings>) => c.json(await listAudit(serviceContext(c), valid(c, 'query'))),
);
