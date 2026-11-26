import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  TemplateAssetParamSchema,
  TemplateVersionDetailSchema,
  TemplateVersionParamSchema,
} from '../../../shared/contracts/index.ts';
import { WalletReportsSchema } from '../../../shared/contracts/wallet-fidelity.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { TemplateAssetQuerySchema, TemplateScopeQuerySchema } from './route-scope.ts';
import { openVersionAsset, versionDetail } from './service.ts';
import { versionWalletReports } from './version-wallet-reports.ts';

type Router = OpenAPIHono<AppBindings>;

export function registerVersionReads(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/versions/{version}',
      summary: 'Template version with its validation report',
      params: TemplateVersionParamSchema,
      query: TemplateScopeQuerySchema,
      response: TemplateVersionDetailSchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await versionDetail(
          serviceContext(c),
          c.var.auth,
          p.id,
          p.version,
          c.req.valid('query').orgId,
        ),
      );
    },
  );

  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/versions/{version}/wallet-reports',
      summary: 'Per-wallet fidelity reports (Google, Samsung) for a template version',
      params: TemplateVersionParamSchema,
      query: TemplateScopeQuerySchema,
      response: WalletReportsSchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      return c.json(
        await versionWalletReports(
          serviceContext(c),
          c.var.auth,
          p.id,
          p.version,
          c.req.valid('query').orgId,
        ),
      );
    },
  );

  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/versions/{version}/assets/{name}',
      summary: 'Template asset bytes',
      params: TemplateAssetParamSchema,
      query: TemplateAssetQuerySchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      const q = c.req.valid('query');
      const asset = await openVersionAsset(
        serviceContext(c),
        c.var.auth,
        p.id,
        p.version,
        p.name,
        q.orgId,
        q.stamps,
      );
      const etag = asset.sha1 ? `"${asset.sha1}"` : null;
      // Version bytes are immutable, but membership and session authorization are not.
      const headers: Record<string, string> = {
        'cache-control': 'private, no-cache',
        'content-type': asset.contentType,
        'x-content-type-options': 'nosniff',
        ...(etag ? { etag } : {}),
      };
      if (etag && c.req.header('if-none-match') === etag) {
        await asset.stream.cancel();
        return new Response(null, { status: 304, headers });
      }
      return new Response(asset.stream, { headers });
    },
  );
}
