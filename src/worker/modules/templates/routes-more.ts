import type { Context } from 'hono';
import type { z } from 'zod';
import {
  IdParamSchema,
  TemplateDetailSchema,
  TemplateReissueResponseSchema,
  UploadListQuerySchema,
  UploadListSchema,
} from '../../../shared/contracts/index.ts';
import type { AppBindings } from '../../platform/context.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { reissueTemplate, setArchived, templatePackage } from './lifecycle.ts';
import { recentUploads } from './service.ts';

type C = Context<AppBindings>;
type Router = ReturnType<typeof createRouter>;
const valid = <T>(c: C, target: 'query' | 'param'): T =>
  (c.req as unknown as { valid(target: string): unknown }).valid(target) as T;
const idOf = (c: C) => valid<{ id: string }>(c, 'param').id;

/** GET /uploads; registered before GET /{id} so "uploads" is not read as an id. */
export function registerUploadList(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/uploads',
      summary: 'Recent template imports',
      query: UploadListQuerySchema,
      response: UploadListSchema,
    },
    async (c: C) =>
      c.json(
        await recentUploads(
          serviceContext(c),
          c.var.auth,
          valid<z.infer<typeof UploadListQuerySchema>>(c, 'query'),
        ),
      ),
  );
}

/** Archive, restore, reissue and the package download. */
export function registerLifecycle(router: Router): void {
  for (const [path, summary, archived] of [
    ['/{id}/archive', 'Archive an uploaded template', true],
    ['/{id}/restore', 'Restore an archived template', false],
  ] as const) {
    register(
      router,
      'templates',
      { method: 'post', path, summary, params: IdParamSchema, response: TemplateDetailSchema },
      async (c: C) => c.json(await setArchived(serviceContext(c), c.var.auth, idOf(c), archived)),
    );
  }

  register(
    router,
    'templates',
    {
      method: 'post',
      path: '/{id}/reissue',
      summary: 'Move passes on older versions to the active version',
      params: IdParamSchema,
      status: 202,
      response: TemplateReissueResponseSchema,
    },
    async (c: C) => c.json(await reissueTemplate(serviceContext(c), c.var.auth, idOf(c)), 202),
  );

  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/{id}/package',
      summary: 'The active version as an uploadable zip',
      params: IdParamSchema,
    },
    async (c: C) => {
      const pkg = await templatePackage(serviceContext(c), c.var.auth, idOf(c));
      return new Response(pkg.bytes, {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${pkg.fileName}"`,
          'cache-control': 'private, no-cache',
          'x-content-type-options': 'nosniff',
        },
      });
    },
  );
}
