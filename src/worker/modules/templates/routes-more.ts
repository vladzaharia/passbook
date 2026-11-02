import {
  IdParamSchema,
  PreviewBatchQuerySchema,
  PreviewBatchSchema,
  TemplateDetailSchema,
  TemplateReissueResponseSchema,
  UploadListQuerySchema,
  UploadListSchema,
} from '../../../shared/contracts/index.ts';
import { type createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { reissueTemplate, setArchived, templatePackage } from './lifecycle.ts';
import { previewMany, recentUploads } from './service.ts';

type Router = ReturnType<typeof createRouter>;

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
    async (c) => c.json(await recentUploads(serviceContext(c), c.var.auth, c.req.valid('query'))),
  );
}

/** GET /previews; registered before GET /{id} so "previews" is not read as an id. */
export function registerPreviewBatch(router: Router): void {
  register(
    router,
    'templates',
    {
      method: 'get',
      path: '/previews',
      summary: 'Sample previews for several templates',
      query: PreviewBatchQuerySchema,
      response: PreviewBatchSchema,
    },
    async (c) => c.json(await previewMany(serviceContext(c), c.var.auth, c.req.valid('query').ids)),
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
      async (c) =>
        c.json(await setArchived(serviceContext(c), c.var.auth, c.req.valid('param').id, archived)),
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
    async (c) =>
      c.json(await reissueTemplate(serviceContext(c), c.var.auth, c.req.valid('param').id), 202),
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
    async (c) => {
      const pkg = await templatePackage(serviceContext(c), c.var.auth, c.req.valid('param').id);
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
