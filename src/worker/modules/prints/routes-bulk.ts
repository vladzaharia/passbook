import {
  BulkPrintParamSchema,
  BulkPrintQuerySchema,
  BulkPrintSchema,
  BulkPrintStartedSchema,
  BulkPrintStatusSchema,
} from '../../../shared/contracts/index.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { recordAudit } from '../audit/service.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  requireTenantSession,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { readBulkStatus, writeBulkStatus } from './bulk-status.ts';
import { PDF_HEADERS } from './pdf-service.ts';
import { bulkKey } from './pdf-store.ts';
import { adminWriter } from './repo-write.ts';
import { ADMIN_PRINTS_PER_HOUR, mintPrint } from './service.ts';

type Router = ReturnType<typeof createRouter>;

/** /api/v1/passes/bulk-print: one combined PDF of a selection (staff sessions with passes:operate). */
export function registerBulkPrintRoutes(passesRoutes: Router): void {
  passesRoutes.use('/bulk-print', requireTenantSession);
  passesRoutes.use('/bulk-print/*', requireTenantSession);

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/bulk-print',
      summary: 'Print up to 50 passes of one org into one PDF; a job renders it',
      body: BulkPrintSchema,
      status: 202,
      response: BulkPrintStartedSchema,
    },
    async (c) => {
      const body = c.req.valid('json');
      assertOrg(c, body.orgId);
      const ctx = svc(c);
      const authority = await tenantAuthorityOf(ctx, authOf(c), body.orgId, 'passes:operate');
      const scope = { ...passScopeOf(c), orgId: authority.orgId };
      const ids = [...new Set(body.ids)];
      const rows = await Promise.all(ids.map((id) => getPass(ctx.env.DB, id, scope)));
      const passes = rows.filter((p): p is Pass => p !== null);
      if (passes.length !== ids.length)
        throw new NotFoundError('Some passes were not found.', 'PASS_NOT_FOUND');
      const caller = {
        writer: adminWriter(authority, actorFor(c)),
        limit: ADMIN_PRINTS_PER_HOUR,
      };
      const printed: string[] = [];
      const skipped: { id: string; code: string }[] = [];
      for (const pass of passes) {
        if (pass.mode !== scope.mode) {
          skipped.push({ id: pass.id, code: 'MODE_MISMATCH' });
          continue;
        }
        try {
          await mintPrint(ctx, caller, pass, false);
          printed.push(pass.id);
        } catch (error) {
          if (!(error instanceof AppError) || error.status >= 500) throw error;
          skipped.push({ id: pass.id, code: error.code });
        }
      }
      if (printed.length === 0) return c.json({ jobId: '', count: 0, skipped }, 202);
      const jobId = ctx.ids.token(16);
      await writeBulkStatus(ctx.env.BUCKET, authority.orgId, jobId, {
        state: 'pending',
        count: printed.length,
        at: ctx.clock.now(),
      });
      await ctx.env.JOBS.send({
        kind: 'prints.bulk',
        orgId: authority.orgId,
        jobId,
        passIds: printed,
      });
      const actor = actorFor(c);
      await recordAudit(ctx, {
        orgId: authority.orgId,
        actorType: actor.type,
        actorId: actor.id,
        action: 'pass.print_bulk',
        targetType: 'org',
        targetId: authority.orgId,
        detail: { count: printed.length, skipped: skipped.length },
      });
      return c.json({ jobId, count: printed.length, skipped }, 202);
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/bulk-print/{jobId}',
      summary: 'State of a bulk Print job',
      params: BulkPrintParamSchema,
      query: BulkPrintQuerySchema,
      response: BulkPrintStatusSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const { jobId } = c.req.valid('param');
      const { orgId } = c.req.valid('query');
      assertOrg(c, orgId);
      await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const status = await readBulkStatus(ctx.env.BUCKET, orgId, jobId, ctx.clock.now());
      if (!status) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
      return c.json(status, 200, { 'cache-control': 'private, no-store' });
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/bulk-print/{jobId}/pdf',
      summary: 'The combined PDF of a finished bulk Print job',
      params: BulkPrintParamSchema,
      query: BulkPrintQuerySchema,
    },
    async (c) => {
      const ctx = svc(c);
      const { jobId } = c.req.valid('param');
      const { orgId } = c.req.valid('query');
      assertOrg(c, orgId);
      await tenantAuthorityOf(ctx, authOf(c), orgId, 'passes:operate');
      const status = await readBulkStatus(ctx.env.BUCKET, orgId, jobId, ctx.clock.now());
      const object =
        status?.state === 'ready' ? await ctx.env.BUCKET.get(bulkKey(orgId, jobId, 'pdf')) : null;
      if (!object) throw new NotFoundError('Print job not found.', 'PRINT_JOB_NOT_FOUND');
      return new Response(object.body, {
        headers: { ...PDF_HEADERS, 'content-disposition': 'attachment; filename="tickets.pdf"' },
      });
    },
  );
}
