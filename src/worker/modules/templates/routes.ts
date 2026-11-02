import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import type { TemplateManifest } from '../../../passkit/types.ts';
import {
  ActivateVersionSchema,
  CloneTemplateSchema,
  DeleteTemplateResponseSchema,
  IdParamSchema,
  ImportStatusSchema,
  PreviewRequestSchema,
  PreviewResponseSchema,
  TemplateAssetParamSchema,
  TemplateDetailSchema,
  TemplateListQuerySchema,
  TemplateListSchema,
  TemplateVersionDetailSchema,
  TemplateVersionParamSchema,
  UpdateManifestSchema,
  UpdateTemplateSchema,
  UploadTemplateQuerySchema,
  UploadTemplateResponseSchema,
} from '../../../shared/contracts/index.ts';
import { methodScope, requireAdmin, requireApiKeyOrAdmin } from '../../platform/auth.ts';
import { defaultBodyLimit } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, PayloadTooLargeError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { activateVersion, cloneTemplate, removeTemplate, replaceManifest } from './mutations.ts';
import { assignOrg } from './org-assignment.ts';
import { registerLifecycle, registerUploadList } from './routes-more.ts';
import { detail, importStatus, list, openVersionAsset, preview, versionDetail } from './service.ts';
import { acceptUpload, UPLOAD_BODY_LIMIT } from './upload.ts';

export const templatesRoutes = createRouter({ bodyLimit: false });
/** The archive upload has its own cap below. */
templatesRoutes.use('*', defaultBodyLimit(/\/uploads$/));
// Reads accept an API key (templates:read); writes are admin only.
templatesRoutes.use('*', async (c, next) =>
  c.req.method === 'GET'
    ? requireApiKeyOrAdmin(methodScope({ read: 'templates:read', write: 'templates:read' }))(
        c,
        next,
      )
    : requireAdmin(c, next),
);
templatesRoutes.use(
  '/uploads',
  bodyLimit({
    maxSize: UPLOAD_BODY_LIMIT,
    onError: () => {
      throw new PayloadTooLargeError('The archive is larger than 15 MB.', 'ARCHIVE_TOO_LARGE');
    },
  }),
);

type C = Context<AppBindings>;
const valid = <T>(c: C, target: 'query' | 'param' | 'json'): T =>
  (c.req as unknown as { valid(target: string): unknown }).valid(target) as T;

async function archiveBytes(c: C): Promise<Uint8Array> {
  const type = c.req.header('content-type') ?? '';
  if (!type.startsWith('multipart/form-data')) return new Uint8Array(await c.req.arrayBuffer());
  const form = await c.req.formData();
  const file = form.get('file') ?? [...form.values()].find((v) => typeof v !== 'string');
  if (!file || typeof file === 'string')
    throw new BadRequestError('Attach the archive as the file field.', 'NO_FILE');
  return new Uint8Array(await file.arrayBuffer());
}

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/',
    summary: 'List templates',
    query: TemplateListQuerySchema,
    response: TemplateListSchema,
  },
  async (c) => c.json(await list(serviceContext(c), c.var.auth, c.req.valid('query'))),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'post',
    path: '/uploads',
    summary: 'Upload a template archive (zip or multipart, up to 15 MB)',
    query: UploadTemplateQuerySchema,
    status: 202,
    response: UploadTemplateResponseSchema,
  },
  async (c) =>
    c.json(
      await acceptUpload(
        serviceContext(c),
        c.var.auth,
        c.req.valid('query'),
        await archiveBytes(c),
      ),
      202,
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/uploads/{id}',
    summary: 'Template import status',
    params: IdParamSchema,
    response: ImportStatusSchema,
  },
  async (c) => c.json(await importStatus(serviceContext(c), c.var.auth, c.req.valid('param').id)),
);

registerUploadList(templatesRoutes);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a template',
    params: IdParamSchema,
    response: TemplateDetailSchema,
  },
  async (c) => c.json(await detail(serviceContext(c), c.var.auth, c.req.valid('param').id)),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Assign a template to an organization, or to none (works for baked templates)',
    params: IdParamSchema,
    body: UpdateTemplateSchema,
    response: TemplateDetailSchema,
  },
  async (c) =>
    c.json(
      await assignOrg(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('json').orgId,
      ),
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete or archive an uploaded template (baked: 403 TEMPLATE_BAKED)',
    params: IdParamSchema,
    response: DeleteTemplateResponseSchema,
  },
  async (c) => {
    const outcome = await removeTemplate(serviceContext(c), c.var.auth, c.req.valid('param').id);
    return c.json({ ok: true as const, outcome });
  },
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'post',
    path: '/{id}/clone',
    summary: 'Clone into an uploaded copy',
    params: IdParamSchema,
    body: CloneTemplateSchema,
    status: 201,
    response: TemplateDetailSchema,
  },
  async (c) =>
    c.json(
      await cloneTemplate(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      201,
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'post',
    path: '/{id}/activate',
    summary: 'Activate a version',
    params: IdParamSchema,
    body: ActivateVersionSchema,
    response: TemplateDetailSchema,
  },
  async (c) =>
    c.json(
      await activateVersion(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'put',
    path: '/{id}/manifest',
    summary: 'Replace the manifest (creates a version)',
    params: IdParamSchema,
    body: UpdateManifestSchema,
    response: TemplateDetailSchema,
  },
  async (c) =>
    c.json(
      await replaceManifest(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('json').manifest,
      ),
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'post',
    path: '/{id}/preview',
    summary: 'Render pass.json for input',
    params: IdParamSchema,
    body: PreviewRequestSchema,
    response: PreviewResponseSchema,
  },
  async (c) =>
    c.json(
      await preview(serviceContext(c), c.var.auth, c.req.valid('param').id, c.req.valid('json')),
    ),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/{id}/versions/{version}',
    summary: 'Template version with its validation report',
    params: TemplateVersionParamSchema,
    response: TemplateVersionDetailSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    return c.json(await versionDetail(serviceContext(c), c.var.auth, p.id, p.version));
  },
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/{id}/versions/{version}/assets/{name}',
    summary: 'Template asset bytes',
    params: TemplateAssetParamSchema,
  },
  async (c) => {
    const p = c.req.valid('param');
    const asset = await openVersionAsset(serviceContext(c), c.var.auth, p.id, p.version, p.name);
    const etag = asset.sha1 ? `"${asset.sha1}"` : null;
    // Versions are content hashes, so a given URL never changes.
    const headers: Record<string, string> = {
      'cache-control': 'private, max-age=31536000, immutable',
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

registerLifecycle(templatesRoutes);
