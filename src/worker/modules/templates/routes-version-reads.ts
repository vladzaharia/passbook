import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  TemplateAssetParamSchema,
  TemplateVersionDetailSchema,
  TemplateVersionParamSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { TemplateScopeQuerySchema } from './route-scope.ts';
import { openVersionAsset, versionDetail } from './service.ts';

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
      path: '/{id}/versions/{version}/assets/{name}',
      summary: 'Template asset bytes',
      params: TemplateAssetParamSchema,
      query: TemplateScopeQuerySchema,
    },
    async (c) => {
      const p = c.req.valid('param');
      const asset = await openVersionAsset(
        serviceContext(c),
        c.var.auth,
        p.id,
        p.version,
        p.name,
        c.req.valid('query').orgId,
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
