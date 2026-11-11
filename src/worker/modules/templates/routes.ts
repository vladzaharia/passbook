import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  CloneTemplateSchema,
  DeleteTemplateResponseSchema,
  EligibleTemplateListSchema,
  EligibleTemplateQuerySchema,
  IdParamSchema,
  ImportStatusSchema,
  PreviewRequestSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListQuerySchema,
  TemplateListSchema,
  UpdateManifestSchema,
  UpdateTemplateSchema,
  UploadTemplateQuerySchema,
  UploadTemplateResponseSchema,
} from '../../../shared/contracts/index.ts';
import { defaultBodyLimit, limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { BadRequestError, PayloadTooLargeError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSession, requireTenantSessionOrApiKey } from '../passes/http.ts';
import { eligibleTemplates } from './eligible.ts';
import { cloneTemplate, removeTemplate, replaceManifest } from './mutations.ts';
import { assignOrg } from './org-assignment.ts';
import { TemplateScopeQuerySchema } from './route-scope.ts';
import {
  registerLifecycle,
  registerPreviewBatch,
  registerUploadList,
  registerVersions,
} from './routes-more.ts';
import { registerTemplateReleases } from './routes-releases.ts';
import { registerVersionReads } from './routes-version-reads.ts';
import { detail, importStatus, list, preview } from './service.ts';
import { acceptUpload, UPLOAD_BODY_LIMIT } from './upload.ts';
import { VERSION_BODY_LIMIT } from './version-files.ts';

export const templatesRoutes = createRouter({ bodyLimit: false });
/** The archive upload and the version save (base64 images) have their own caps below. */
templatesRoutes.use('*', defaultBodyLimit(/\/(uploads|[^/]+\/versions)$/));
// Template reads allow scoped API keys; mutations require a session and are authorized per org.
templatesRoutes.use('*', async (c, next) =>
  c.req.method === 'GET'
    ? requireTenantSessionOrApiKey(
        /\/templates\/eligible\/?$/.test(c.req.path)
          ? ['templates:read', 'passes:read']
          : 'templates:read',
      )(c, next)
    : requireTenantSession(c, next),
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

/** Up to 15 MB of files as base64, plus the documents. */
templatesRoutes.use('/:id/versions', limitBody(VERSION_BODY_LIMIT));

type C = Context<AppBindings>;

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
      await acceptUpload(serviceContext(c), c.var.auth, c.req.valid('query'), () =>
        archiveBytes(c),
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
    query: TemplateScopeQuerySchema,
    response: ImportStatusSchema,
  },
  async (c) =>
    c.json(
      await importStatus(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('query').orgId,
      ),
    ),
);

registerUploadList(templatesRoutes);
registerPreviewBatch(templatesRoutes);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/eligible',
    summary: 'List release-backed templates available to an organization',
    query: EligibleTemplateQuerySchema,
    response: EligibleTemplateListSchema,
  },
  async (c) => c.json(await eligibleTemplates(serviceContext(c), c.var.auth, c.req.valid('query'))),
);

register(
  templatesRoutes,
  'templates',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get a template',
    params: IdParamSchema,
    query: TemplateScopeQuerySchema,
    response: TemplateDetailSchema,
  },
  async (c) =>
    c.json(
      await detail(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('query').orgId,
      ),
    ),
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
    summary: 'Clone into an inactive uploaded draft',
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
    method: 'put',
    path: '/{id}/manifest',
    summary: 'Save the manifest as an inactive version',
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
    query: TemplateScopeQuerySchema,
    body: PreviewRequestSchema,
    response: PreviewResponseSchema,
  },
  async (c) =>
    c.json(
      await preview(
        serviceContext(c),
        c.var.auth,
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.valid('query').orgId,
      ),
    ),
);

registerVersionReads(templatesRoutes);

registerVersions(templatesRoutes);
registerLifecycle(templatesRoutes);
registerTemplateReleases(templatesRoutes);
