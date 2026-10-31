import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { createRouter, guard, stub } from '../../platform/openapi.ts';

export const auditRoutes = createRouter();
guard(auditRoutes, requireAdmin);
stub(auditRoutes, 'audit', {
  method: 'get',
  path: '/',
  summary: 'Query the audit log',
  query: AuditQuerySchema,
  response: AuditListSchema,
});
