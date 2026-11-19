import {
  BulkPrintParamSchema,
  BulkPrintQuerySchema,
  BulkPrintSchema,
  BulkPrintStartedSchema,
  BulkPrintStatusSchema,
} from '../../../shared/contracts/index.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import {
  actorFor,
  assertOrg,
  authOf,
  passScopeOf,
  requireTenantSession,
  svc,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { bulkPrintPdf, bulkPrintStatus, startBulkPrint } from './bulk-service.ts';
import { PDF_HEADERS } from './pdf-service.ts';

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
      const auth = authOf(c);
      if (auth.kind !== 'session') throw new ForbiddenError();
      const authority = await tenantAuthorityOf(ctx, auth, body.orgId, 'passes:operate');
      const scope = { ...passScopeOf(c), orgId: authority.orgId };
      const caller = { authority, userId: auth.userId, mode: scope.mode, actor: actorFor(c) };
      return c.json(await startBulkPrint(ctx, caller, scope, body.ids), 202);
    },
  );

  const whoOf = async (c: Parameters<typeof svc>[0], orgId: string) => {
    assertOrg(c, orgId);
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new ForbiddenError();
    await tenantAuthorityOf(svc(c), auth, orgId, 'passes:operate');
    return { orgId, userId: auth.userId, mode: passScopeOf(c).mode };
  };

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
      const { jobId } = c.req.valid('param');
      const who = await whoOf(c, c.req.valid('query').orgId);
      const status = await bulkPrintStatus(svc(c), who, jobId);
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
      const { jobId } = c.req.valid('param');
      const who = await whoOf(c, c.req.valid('query').orgId);
      const object = await bulkPrintPdf(svc(c), who, jobId);
      return new Response(object.body, {
        headers: { ...PDF_HEADERS, 'content-disposition': 'attachment; filename="tickets.pdf"' },
      });
    },
  );
}
