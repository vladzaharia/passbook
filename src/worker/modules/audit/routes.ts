import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin, requireSession } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { listPlatformAudit, listTenantAudit } from './service.ts';

export const auditRoutes = createRouter();
guard(auditRoutes, requireSession);
auditRoutes.use('/platform', requireAdmin);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/',
    summary: 'Query an organization audit log',
    query: AuditQuerySchema,
    response: AuditListSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    return c.json(await listTenantAudit(serviceContext(c), auth.userId, c.req.valid('query')));
  },
);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/platform',
    summary: 'Query the platform audit log',
    query: AuditQuerySchema,
    response: AuditListSchema,
  },
  async (c) => c.json(await listPlatformAudit(serviceContext(c), c.req.valid('query'))),
);
