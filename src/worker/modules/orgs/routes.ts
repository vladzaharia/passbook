import type { Context } from 'hono';
import { z } from 'zod';
import {
  BrandingSlotParamSchema,
  EmailPreviewQuerySchema,
  IdParamSchema,
  IdSchema,
  OrgSchema,
  OrgSummarySchema,
  UpdateOrgSchema,
  UploadBrandingImageSchema,
} from '../../../shared/contracts/index.ts';
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { modeOf } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { deleteBrandingImage, getBrandingImage, putBrandingImage } from './branding.ts';
import { renderEmailPreview } from './email-preview.ts';
import { membershipRoutes } from './membership-routes.ts';
import { adminOf, orgsPlatformRoutes } from './routes-platform.ts';
import { getOrg, updateOrg } from './service.ts';

export const orgsRoutes = createRouter();
// Membership endpoints have their own guards, including a public invitation landing page.
orgsRoutes.route('/', membershipRoutes);
// Directory and lifecycle are platform operations: each route declares its own `{ platform }` access, ahead of the
// tenant guard below, which would turn a key away with 401.
orgsRoutes.route('/', orgsPlatformRoutes);
guard(orgsRoutes, requireTenantSession);
// Two base64 PNGs of at most 200 KB each, plus JSON overhead.
orgsRoutes.use('*', limitBody(1024 * 1024));

async function authorizeOrg(c: Context<AppBindings>, id: string, capability: OrgCapability) {
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const authority = await tenantAuthorityOf(serviceContext(c), auth, id, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}/workspace',
    summary: 'Get an organization workspace',
    params: IdParamSchema,
    response: OrgSummarySchema,
  },
  async (c) => {
    const id = c.req.valid('param').id;
    await authorizeOrg(c, id, 'org:read');
    return c.json(await getOrg(serviceContext(c), id, modeOf(c.var.auth)));
  },
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
  async (c) => {
    const id = c.req.valid('param').id;
    const input = c.req.valid('json');
    const authority = await authorizeOrg(c, id, 'org:manage');
    // The status route is platform-only; PATCH must not be a tenant lifecycle bypass.
    if (input.status !== undefined && !authority.sessionRoles.includes('admin'))
      throw new ForbiddenError();
    const admin = input.status === undefined ? undefined : adminOf(c);
    return c.json(await updateOrg(serviceContext(c), requestActor(c), id, input, authority, admin));
  },
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
  async (c) => {
    const { id, slot } = c.req.valid('param');
    const authority = await authorizeOrg(c, id, 'org:manage');
    return c.json(
      await putBrandingImage(
        serviceContext(c),
        requestActor(c),
        id,
        slot,
        c.req.valid('json'),
        undefined,
        authority,
      ),
    );
  },
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
  async (c) => {
    const { id, slot } = c.req.valid('param');
    const authority = await authorizeOrg(c, id, 'org:manage');
    return c.json(
      await deleteBrandingImage(serviceContext(c), requestActor(c), id, slot, authority),
    );
  },
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
    await authorizeOrg(c, p.id, 'org:read');
    const bytes = await getBrandingImage(serviceContext(c), p.id, p.slot, p.scale === '3x' ? 3 : 2);
    return c.body(bytes, 200, {
      'content-type': 'image/png',
      'cache-control': 'private, no-cache',
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
    await authorizeOrg(c, c.req.valid('param').id, 'templates:read');
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
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      'x-frame-options': 'SAMEORIGIN',
    });
  },
);
