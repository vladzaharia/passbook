import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
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
  async (c) => c.json(await listAudit(serviceContext(c), c.req.valid('query'))),
);
