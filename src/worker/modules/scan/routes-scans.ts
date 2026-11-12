import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  IdParamSchema,
  ScanFeedSchema,
  ScanListQuerySchema,
  ScanOutcomeSchema,
  ScanRecordListSchema,
  ScanRecordSchema,
  ScanUndoRequestSchema,
} from '../../../shared/contracts/index.ts';
import { assertOrgAccess, modeOf, type SessionAuth } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { getOrgAccess, rolesGranting } from '../orgs/access.ts';
import {
  requireTenantSession,
  requireTenantSessionOrApiKey,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { credentialKeysetContext } from './credential-keyset-authority.ts';
import { ScanExportQuerySchema } from './dto-console.ts';
import {
  type ConsoleUndo,
  exportScans,
  listScanFeed,
  listScanRecords,
  loadUndoRow,
  scanRecord,
  UNDO_MAX_MS,
} from './feed.ts';

import { consoleUndo } from './undo.ts';

const TAG = 'scans';

/** The console's undo takes the key only; the org comes from the scan. */
const ConsoleUndoSchema = ScanUndoRequestSchema.pick({ idempotencyKey: true });

/** A missing membership is indistinguishable from a foreign tenant resource. */
async function scanAuthority(
  ctx: ServiceContext,
  session: SessionAuth,
  orgId: string,
  capability: 'scanning:read' | 'passes:operate',
) {
  const membership = await getOrgAccess(ctx, session.userId, orgId);
  if (!membership) return null;
  if (!membership.capabilities.includes(capability)) throw new ForbiddenError();
  const authority = await tenantAuthorityOf(ctx, session, orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  // Console records project pass-derived data as well as scanner metadata.
  if (capability === 'scanning:read') {
    const passReaders = rolesGranting('passes:read');
    if (!authority.roles.some((role) => passReaders.includes(role))) throw new ForbiddenError();
  }
  return authority;
}

/**
 * The scans log and feed: API keys with `scans:read` receive the limited feed, and tenant
 * members with `scanning:read` receive records scoped to the requested organization.
 */
export function createScansRoutes(deps: { undo: ConsoleUndo }) {
  const routes = createRouter();
  const keyOrSession = requireTenantSessionOrApiKey('scans:read');
  routes.use(
    '*',
    createMiddleware<AppBindings>(async (c, next) => {
      const isList = c.req.method === 'GET' && /\/scans\/?$/.test(c.req.path);
      return isList ? keyOrSession(c, next) : requireTenantSession(c, next);
    }),
  );
  routes.use('*', limitBody(16 * 1024));

  register(
    routes,
    TAG,
    {
      method: 'get',
      path: '/',
      summary: 'List scans (admins) or the scan feed (API keys with scans:read)',
      query: ScanListQuerySchema,
      response: z.union([ScanRecordListSchema, ScanFeedSchema]),
    },
    async (c) => {
      const ctx = credentialKeysetContext(serviceContext(c));
      const auth = c.var.auth;
      const query = c.req.valid('query');
      const filter = { ...query, mode: modeOf(auth) };
      if (auth?.kind === 'api_key') {
        if (query.q !== undefined)
          throw new ForbiddenError(
            'Pass-name search is for administrators.',
            'SCAN_SEARCH_FORBIDDEN',
          );
        // An org-scoped key sees its org; a platform key may name one.
        const orgId = auth.orgId ?? query.orgId;
        if (query.orgId) assertOrgAccess(auth, query.orgId);
        return c.json(await listScanFeed(ctx, auth, { ...filter, orgId }));
      }
      if (auth?.kind !== 'session') throw new UnauthenticatedError();
      if (!query.orgId)
        throw new ValidationError('Select an organization to list scans.', [], 'ORG_REQUIRED');
      const authority = await scanAuthority(ctx, auth, query.orgId, 'scanning:read');
      if (!authority) return c.json({ items: [], nextCursor: null });
      return c.json(await listScanRecords(ctx, auth, authority, filter));
    },
  );
  register(
    routes,
    TAG,
    {
      method: 'get',
      path: '/export',
      summary: 'Export scans as CSV (up to 92 days and 100,000 rows)',
      query: ScanExportQuerySchema,
    },
    async (c) => {
      const { orgId, from, to, ...filter } = c.req.valid('query');
      const session = c.var.auth;
      if (session?.kind !== 'session') throw new UnauthenticatedError();
      const ctx = credentialKeysetContext(serviceContext(c));
      const authority = await scanAuthority(ctx, session, orgId, 'scanning:read');
      if (!authority) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
      const out = await exportScans(ctx, session, authority, { orgId, from, to, filter });
      return new Response(out.body, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${out.name}"`,
          'cache-control': 'no-store',
        },
      });
    },
  );
  register(
    routes,
    TAG,
    {
      method: 'get',
      path: '/{id}',
      summary: 'Get a scan',
      params: IdParamSchema,
      response: ScanRecordSchema,
    },
    async (c) => {
      const session = c.var.auth;
      if (session?.kind !== 'session') throw new UnauthenticatedError();
      const ctx = credentialKeysetContext(serviceContext(c));
      const id = c.req.valid('param').id;
      const scan = await loadUndoRow(ctx, id);
      const authority = await scanAuthority(ctx, session, scan.orgId, 'scanning:read');
      if (!authority) throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
      return c.json(await scanRecord(ctx, session, authority, id));
    },
  );
  register(
    routes,
    TAG,
    {
      method: 'post',
      path: '/{id}/undo',
      summary: 'Undo a scan (up to 30 days old)',
      params: IdParamSchema,
      body: ConsoleUndoSchema,
      response: ScanOutcomeSchema,
    },
    async (c) => {
      const ctx = credentialKeysetContext(serviceContext(c));
      const session = c.var.auth;
      if (session?.kind !== 'session') throw new UnauthenticatedError();
      const scan = await loadUndoRow(ctx, c.req.valid('param').id);
      if (!(await scanAuthority(ctx, session, scan.orgId, 'passes:operate')))
        throw new NotFoundError('Scan not found.', 'SCAN_NOT_FOUND');
      if (scan.mode !== modeOf(c.var.auth))
        throw new ForbiddenError('Switch mode to undo this scan.', 'SCAN_MODE_MISMATCH');
      if (ctx.clock.now() - scan.at > UNDO_MAX_MS)
        throw new ForbiddenError('Scans older than 30 days cannot be undone.', 'SCAN_UNDO_EXPIRED');
      const outcome = await deps.undo(ctx, session, {
        scanId: scan.id,
        orgId: scan.orgId,
        mode: scan.mode,
        idempotencyKey: c.req.valid('json').idempotencyKey,
        maxAgeMs: UNDO_MAX_MS,
      });
      return c.json(outcome);
    },
  );
  return routes;
}

export const scansRoutes = createScansRoutes({ undo: consoleUndo });
