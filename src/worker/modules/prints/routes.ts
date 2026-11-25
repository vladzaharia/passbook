import { z } from 'zod';
import {
  IdParamSchema,
  MintedPrintSchema,
  PassPrintSchema,
  PassPrintsResponseSchema,
  PrintParamSchema,
} from '../../../shared/contracts/index.ts';
import { AppError } from '../../platform/errors.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { renderErrorPage } from '../../ssr/error-page.tsx';
import { requestTheme } from '../../ssr/head.ts';
import { PRINT_HEADERS, renderPrintPage } from '../../ssr/print-page.tsx';
import { orgBrandOf } from '../orgs/brand.ts';
import { actorFor, authOf, passScopeOf, svc } from '../passes/http.ts';
import { tenantPassForRead, tenantPassForWrite } from '../passes/pass-access.ts';
import { openPublicAsset } from '../public/service.ts';
import { printPageModel } from './page.ts';
import { PDF_HEADERS, ticketPdf } from './pdf-service.ts';
import * as repo from './repo.ts';
import { adminWriter } from './repo-write.ts';
import { registerBulkPrintRoutes } from './routes-bulk.ts';
import { ADMIN_PRINTS_PER_HOUR, mintPrint, voidPrint } from './service.ts';

type Router = ReturnType<typeof createRouter>;

/** /api/v1/passes/{id}/prints: staff and keys with passes:operate or passes:write. */
export function registerPassPrintRoutes(passesRoutes: Router): void {
  registerBulkPrintRoutes(passesRoutes);

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/prints',
      summary: 'Print a ticket; an earlier print of the pass is voided',
      xFeature: 'print',
      params: IdParamSchema,
      response: MintedPrintSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const { id } = c.req.valid('param');
      const { pass, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const caller = { writer: adminWriter(authority, actorFor(c)), limit: ADMIN_PRINTS_PER_HOUR };
      return c.json(await mintPrint(ctx, caller, pass, true));
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/prints',
      summary: "A pass's prints, newest first; codes are never listed",
      params: IdParamSchema,
      response: PassPrintsResponseSchema,
    },
    async (c) => {
      const { id } = c.req.valid('param');
      const { pass } = await tenantPassForRead(svc(c), authOf(c), id, passScopeOf(c));
      return c.json({ prints: await repo.listPrints(svc(c).env.DB, pass.id) });
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'post',
      path: '/{id}/prints/{printId}/void',
      summary: 'Void a printed ticket',
      params: PrintParamSchema,
      response: PassPrintSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const { id, printId } = c.req.valid('param');
      const { pass, authority } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const caller = { writer: adminWriter(authority, actorFor(c)), limit: ADMIN_PRINTS_PER_HOUR };
      return c.json(await voidPrint(ctx, caller, pass, 'manual', printId));
    },
  );
  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/print',
      summary: 'The print page of the active print, for staff',
      params: IdParamSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const theme = requestTheme(c);
      try {
        const { id } = c.req.valid('param');
        const { pass } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
        const brand = await orgBrandOf(ctx, pass.orgId);
        const model = await printPageModel(ctx, pass, 'staff', brand, true);
        const html = renderPrintPage({
          model,
          audience: 'staff',
          nonce: c.var.nonce,
          brand,
          pdfHref: `/api/v1/passes/${encodeURIComponent(pass.id)}/print/pdf`,
          assetBase: `/api/v1/passes/${encodeURIComponent(pass.id)}/print/assets/`,
          ...(theme ? { theme } : {}),
        });
        return new Response(html, { headers: PRINT_HEADERS });
      } catch (error) {
        // A browser tab, not an API client: the hosted error page, same status.
        if (!(error instanceof AppError) || error.status >= 500) throw error;
        const html = renderErrorPage({
          status: error.status,
          nonce: c.var.nonce,
          ...(theme ? { theme } : {}),
          ...(error.status === 404 ? {} : { line: error.message }),
        });
        return new Response(html, { status: error.status, headers: PRINT_HEADERS });
      }
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/print/pdf',
      summary: 'The PDF of the active print, for staff',
      params: IdParamSchema,
    },
    async (c) => {
      const ctx = svc(c);
      const { id } = c.req.valid('param');
      const { pass } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      return new Response(await ticketPdf(ctx, pass, 'staff'), { headers: PDF_HEADERS });
    },
  );

  register(
    passesRoutes,
    'passes',
    {
      method: 'get',
      path: '/{id}/print/assets/{name}',
      summary: 'A template image of the print page, for staff',
      params: IdParamSchema.extend({ name: z.string().max(200) }),
    },
    async (c) => {
      const ctx = svc(c);
      const { id, name } = c.req.valid('param');
      const { pass } = await tenantPassForWrite(ctx, authOf(c), id, passScopeOf(c));
      const asset = await openPublicAsset(ctx, pass, name);
      return new Response(asset.body, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  );
}
