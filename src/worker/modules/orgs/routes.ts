import { z } from 'zod';
import {
  BrandingSlotParamSchema,
  CreateOrgSchema,
  EmailPreviewQuerySchema,
  IdParamSchema,
  IdSchema,
  OkSchema,
  OrgListQuerySchema,
  OrgListSchema,
  OrgSchema,
  OrgStatusSchema,
  OrgSummarySchema,
  UpdateOrgSchema,
  UploadBrandingImageSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { deleteBrandingImage, getBrandingImage, putBrandingImage } from './branding.ts';
import { renderEmailPreview } from './email-preview.ts';
import { createOrg, deleteOrg, getOrg, listOrgs, setOrgStatus, updateOrg } from './service.ts';

export const orgsRoutes = createRouter();
guard(orgsRoutes, requireAdmin);
// Two base64 PNGs of at most 200 KB each, plus JSON overhead.
orgsRoutes.use('*', limitBody(1024 * 1024));

register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/',
    summary: 'List organizations',
    query: OrgListQuerySchema,
    response: OrgListSchema,
  },
  async (c) => c.json(await listOrgs(serviceContext(c), c.req.valid('query'))),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'post',
    path: '/',
    summary: 'Create an organization',
    body: CreateOrgSchema,
    status: 201,
    response: OrgSchema,
  },
  async (c) =>
    c.json(await createOrg(serviceContext(c), requestActor(c), c.req.valid('json')), 201),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an organization',
    params: IdParamSchema,
    response: OrgSummarySchema,
  },
  async (c) => c.json(await getOrg(serviceContext(c), c.req.valid('param').id)),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'patch',
    path: '/{id}',
    summary: 'Update an organization',
    params: IdParamSchema,
    body: UpdateOrgSchema,
    response: OrgSchema,
  },
  async (c) =>
    c.json(
      await updateOrg(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'post',
    path: '/{id}/status',
    summary: 'Suspend or reactivate an organization',
    params: IdParamSchema,
    body: OrgStatusSchema,
    response: OrgSchema,
  },
  async (c) =>
    c.json(
      await setOrgStatus(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json').status,
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'put',
    path: '/{id}/branding/{slot}',
    summary: 'Upload the pass logo or icon (@3x PNG; @2x derived)',
    params: BrandingSlotParamSchema,
    body: UploadBrandingImageSchema,
    response: OrgSchema,
  },
  async (c) =>
    c.json(
      await putBrandingImage(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('param').slot,
        c.req.valid('json'),
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'delete',
    path: '/{id}/branding/{slot}',
    summary: 'Remove the pass logo or icon',
    params: BrandingSlotParamSchema,
    response: OrgSchema,
  },
  async (c) =>
    c.json(
      await deleteBrandingImage(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('param').slot,
      ),
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}/branding/{slot}/{scale}',
    summary: 'Download the pass logo or icon',
    params: z.object({
      id: IdSchema,
      slot: BrandingSlotParamSchema.shape.slot,
      scale: z.enum(['2x', '3x']),
    }),
  },
  async (c) => {
    const p = c.req.valid('param');
    const bytes = await getBrandingImage(serviceContext(c), p.id, p.slot, p.scale === '3x' ? 3 : 2);
    return c.body(bytes, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    });
  },
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}/email-preview',
    summary: 'The pass email as holders get it, with sample holder data (HTML)',
    params: IdParamSchema,
    query: EmailPreviewQuerySchema,
  },
  async (c) => {
    const { buddy, supportEmail, supportUrl } = c.req.valid('query');
    const html = await renderEmailPreview(
      serviceContext(c),
      c.req.valid('param').id,
      new URL(c.req.url).origin,
      {
        ...(buddy === undefined ? {} : { buddy: buddy === '1' }),
        ...(supportEmail === undefined ? {} : { supportEmail }),
        ...(supportUrl === undefined ? {} : { supportUrl }),
      },
    );
    return c.body(html, 200, {
      'content-type': 'text/html; charset=utf-8',
      // Inline styles, as in a mail client; no script. Only the console may frame it.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'x-frame-options': 'SAMEORIGIN',
    });
  },
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'delete',
    path: '/{id}',
    summary: 'Delete an organization',
    params: IdParamSchema,
    response: OkSchema,
  },
  async (c) => {
    await deleteOrg(serviceContext(c), requestActor(c), c.req.valid('param').id);
    return c.json({ ok: true });
  },
);
