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
import {
  assertOrgAccess,
  currentUserId,
  modeOf,
  requireAdmin,
  requireApiKeyOrAdmin,
} from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { ScanExportQuerySchema } from './dto-console.ts';
import {
  type ConsoleUndo,
  exportScans,
  listScanFeed,
  listScanRecords,
  loadScanRow,
  scanRecord,
  UNDO_MAX_MS,
} from './feed.ts';

import { consoleUndo } from './undo.ts';

const TAG = 'scans';

/** The console's undo takes the key only; the org comes from the scan. */
const ConsoleUndoSchema = ScanUndoRequestSchema.pick({ idempotencyKey: true });

/**
 * The scans log and feed: /api/v1/scans. The list answers an API key with `scans:read`
 * (`ScanFeedRow`: no titles, no staff names) or an admin (`ScanRecord`); everything else is an
 * admin's. `undo` is SV.6's service, handed in so the router can be built around a stand-in.
 */
export function createScansRoutes(deps: { undo: ConsoleUndo }) {
  const routes = createRouter();
  const keyOrAdmin = requireApiKeyOrAdmin('scans:read');
  routes.use(
    '*',
    createMiddleware<AppBindings>(async (c, next) => {
      const isList = c.req.method === 'GET' && /\/scans\/?$/.test(c.req.path);
      return isList ? keyOrAdmin(c, next) : requireAdmin(c, next);
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
      const ctx = serviceContext(c);
      const auth = c.var.auth;
      const query = c.req.valid('query');
      const filter = { ...query, mode: modeOf(auth) };
      if (auth?.kind === 'api_key') {
        // An org-scoped key sees its org; a platform key may name one.
        const orgId = auth.orgId ?? query.orgId;
        if (query.orgId) assertOrgAccess(auth, query.orgId);
        return c.json(await listScanFeed(ctx, { ...filter, orgId }));
      }
      return c.json(await listScanRecords(ctx, filter));
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
      const out = await exportScans(serviceContext(c), currentUserId(c), {
        mode: modeOf(c.var.auth),
        orgId,
        from,
        to,
        filter,
      });
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
    async (c) => c.json(await scanRecord(serviceContext(c), c.req.valid('param').id)),
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
      const ctx = serviceContext(c);
      const session = c.var.auth;
      if (session?.kind !== 'session') throw new UnauthenticatedError();
      const scan = await loadScanRow(ctx, c.req.valid('param').id);
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
