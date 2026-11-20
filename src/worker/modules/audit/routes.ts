import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin, requireSession } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { auditCsvStream } from './export.ts';
import { listPlatformAudit, listTenantAudit } from './service.ts';

export const auditRoutes = createRouter();
guard(auditRoutes, requireSession);
auditRoutes.use('/platform', requireAdmin);
auditRoutes.use('/platform/*', requireAdmin);

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

const csvHeaders = {
  'content-type': 'text/csv; charset=utf-8',
  'content-disposition': 'attachment; filename="audit-log.csv"',
  'cache-control': 'no-store',
};

// Same filters as the list; the page size is the export's own, and the cursor is the export's.
const ExportQuerySchema = AuditQuerySchema.omit({ cursor: true, limit: true });

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/export',
    summary: 'Export an organization audit log as CSV',
    query: ExportQuerySchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    const body = await auditCsvStream((cursor) =>
      listTenantAudit(ctx, auth.userId, { ...query, cursor, limit: 200 }),
    );
    return new Response(body, { headers: csvHeaders });
  },
);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/platform/export',
    summary: 'Export the platform audit log as CSV',
    query: ExportQuerySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    const body = await auditCsvStream((cursor) =>
      listPlatformAudit(ctx, { ...query, cursor, limit: 200 }),
    );
    return new Response(body, { headers: csvHeaders });
  },
);
