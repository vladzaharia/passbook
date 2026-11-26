import { AuditListSchema, AuditQuerySchema } from '../../../shared/contracts/index.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { auditCsv } from './export.ts';
import { enforceExportLimit } from './export-limit.ts';
import { requestActor } from './http.ts';
import {
  assertKeyWindow,
  auditActor,
  listPlatformAudit,
  listTenantAudit,
  recordAudit,
  tenantAuditReader,
} from './service.ts';

export const auditRoutes = createRouter();

/** An org key reads its own org's log: a named scope, 90 days at a time. A platform log is a platform admin's session alone. */
const TENANT_AUTH = { scope: 'audit:read', capability: 'audit:read' } as const;

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/',
    summary: 'Query an organization audit log',
    auth: TENANT_AUTH,
    query: AuditQuerySchema,
    response: AuditListSchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (!auth) throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    if (auth.kind === 'api_key') assertKeyWindow(ctx, query, true);
    return c.json(await listTenantAudit(ctx, auth, query));
  },
);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/platform',
    summary: 'Query the platform audit log',
    auth: { platform: 'platform:audit' },
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
    summary:
      'Export an organization audit log as CSV (10,000 entries at most; 6 an hour for a person, 2 an hour for a key)',
    auth: TENANT_AUTH,
    query: ExportQuerySchema,
  },
  async (c) => {
    const auth = c.var.auth;
    if (!auth) throw new UnauthenticatedError();
    const ctx = serviceContext(c);
    const query = c.req.valid('query');
    const byKey = auth.kind === 'api_key';
    if (byKey) assertKeyWindow(ctx, { ...query, limit: 1, cursor: undefined }, false);
    const reader = await tenantAuditReader(ctx, auth, query);
    const out = await auditCsv(
      (cursor, limit) => listTenantAudit(ctx, auth, { ...query, cursor, limit }, reader),
      () =>
        enforceExportLimit(
          ctx,
          byKey
            ? [
                { key: `key:${auth.keyId}`, limit: 2 },
                { key: `org-keys:${auth.orgId}`, limit: 6 },
              ]
            : [`user:${auth.kind === 'session' ? auth.userId : ''}`, `org:${query.orgId}`],
        ),
    );
    // A key's export is read by no one at the time: it leaves a trail.
    if (byKey)
      await recordAudit(ctx, {
        orgId: auth.orgId,
        ...auditActor(requestActor(c)),
        action: 'audit.export',
        targetType: 'org',
        targetId: auth.orgId,
        detail: { rows: out.rows, truncated: out.truncated },
      });
    return csvResponse(out);
  },
);

register(
  auditRoutes,
  'audit',
  {
    method: 'get',
    path: '/platform/export',
    summary: 'Export the platform audit log as CSV (10,000 entries at most; 6 an hour)',
    auth: { platform: 'platform:audit' },
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
