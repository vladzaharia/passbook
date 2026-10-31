import { z } from 'zod';
import {
  ActivateVersionSchema,
  CloneTemplateSchema,
  IdParamSchema,
  ImportStatusSchema,
  OkSchema,
  PreviewRequestSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListQuerySchema,
  TemplateListSchema,
  UpdateManifestSchema,
  UploadTemplateQuerySchema,
  UploadTemplateResponseSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, requireAdmin, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { createRouter, stub } from '../../platform/openapi.ts';

export const templatesRoutes = createRouter();
// Reads accept an API key (templates:read); writes are admin only.
templatesRoutes.use('*', async (c, next) =>
  c.req.method === 'GET'
    ? requireApiKeyOrAdmin(methodScope({ read: 'templates:read', write: 'templates:read' }))(
        c,
        next,
      )
    : requireAdmin(c, next),
);

stub(templatesRoutes, 'templates', {
  method: 'get',
  path: '/',
  summary: 'List templates',
  query: TemplateListQuerySchema,
  response: TemplateListSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'post',
  path: '/uploads',
  summary: 'Upload a template archive (zip or multipart, up to 15 MB)',
  query: UploadTemplateQuerySchema,
  status: 202,
  response: UploadTemplateResponseSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'get',
  path: '/uploads/{id}',
  summary: 'Template import status',
  params: IdParamSchema,
  response: ImportStatusSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'get',
  path: '/{id}',
  summary: 'Get a template',
  params: IdParamSchema,
  response: TemplateDetailSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'delete',
  path: '/{id}',
  summary: 'Delete or archive an uploaded template (baked: 403 TEMPLATE_BAKED)',
  params: IdParamSchema,
  response: OkSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'post',
  path: '/{id}/clone',
  summary: 'Clone into an uploaded copy',
  params: IdParamSchema,
  body: CloneTemplateSchema,
  status: 201,
  response: TemplateDetailSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'post',
  path: '/{id}/activate',
  summary: 'Activate a version',
  params: IdParamSchema,
  body: ActivateVersionSchema,
  response: TemplateDetailSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'put',
  path: '/{id}/manifest',
  summary: 'Replace the manifest (creates a version)',
  params: IdParamSchema,
  body: UpdateManifestSchema,
  response: TemplateDetailSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'post',
  path: '/{id}/preview',
  summary: 'Render pass.json for input',
  params: IdParamSchema,
  body: PreviewRequestSchema,
  response: PreviewResponseSchema,
});
stub(templatesRoutes, 'templates', {
  method: 'get',
  path: '/{id}/versions/{version}/assets/{name}',
  summary: 'Template asset bytes',
  params: IdParamSchema.extend({ version: z.string(), name: z.string() }),
});
