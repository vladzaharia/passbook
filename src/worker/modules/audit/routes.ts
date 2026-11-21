import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { requireAdmin, requireConsoleSession } from '../../platform/auth.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { auditCsv } from './export.ts';
import { enforceExportLimit } from './export-limit.ts';
import { listPlatformAudit, listTenantAudit } from './service.ts';

export const auditRoutes = createRouter();
guard(auditRoutes, requireConsoleSession);
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

const csvResponse = ({ csv, truncated }: { csv: string; truncated: boolean }) =>
  new Response(csv, {
    headers: { ...csvHeaders, ...(truncated ? { 'x-export-truncated': '1' } : {}) },
  });

// Same filters as the list; the page size and cursor are the export's own.
const ExportQuerySchema = AuditQuerySchema.omit({ cursor: true, limit: true });

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/export',
    summary: 'Export an organization audit log as CSV (10,000 entries at most; 6 an hour)',
    query: ExportQuerySchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    return csvResponse(
      await auditCsv(
        (cursor, limit) => listTenantAudit(ctx, auth.userId, { ...query, cursor, limit }),
        () => enforceExportLimit(ctx, [`user:${auth.userId}`, `org:${query.orgId}`]),
      ),
    );
  },
);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/platform/export',
    summary: 'Export the platform audit log as CSV (10,000 entries at most; 6 an hour)',
    query: ExportQuerySchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (auth?.kind !== 'session') throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    return csvResponse(
      await auditCsv(
        (cursor, limit) => listPlatformAudit(ctx, { ...query, cursor, limit }),
        () => enforceExportLimit(ctx, [`user:${auth.userId}`]),
      ),
    );
  },
);
