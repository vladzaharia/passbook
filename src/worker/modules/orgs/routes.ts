import type { Context } from 'hono';
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
import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { modeOf, requireAdmin } from '../../platform/auth.ts';
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
import type { OrgAdmin } from './repo-org-writes.ts';
import { createOrg, deleteOrg, getOrg, listOrgs, setOrgStatus, updateOrg } from './service.ts';

// Platform provisioning deliberately exposes only the directory projection, not workspace data.
const PlatformOrgSummarySchema = OrgSummarySchema.pick({
  id: true,
  slug: true,
  name: true,
  status: true,
  createdAt: true,
  counts: true,
  countsCapped: true,
});
const PlatformOrgListSchema = OrgListSchema.extend({ items: z.array(PlatformOrgSummarySchema) });

export const orgsRoutes = createRouter();
// Membership endpoints have their own guards, including a public invitation landing page.
orgsRoutes.route('/', membershipRoutes);
guard(orgsRoutes, requireTenantSession);
// Directory and lifecycle are platform operations, not tenant workspace access.
orgsRoutes.use('/', requireAdmin);
orgsRoutes.use('/:id/status', requireAdmin);
orgsRoutes.use('/:id', (c, next) =>
  c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'DELETE'
    ? requireAdmin(c, next)
    : next(),
);
// Two base64 PNGs of at most 200 KB each, plus JSON overhead.
orgsRoutes.use('*', limitBody(1024 * 1024));

/** The signed-in admin session: requireAdmin already proved it, and the platform grant re-checks it at commit. */
function adminOf(c: Context<AppBindings>): OrgAdmin | undefined {
  const auth = c.var.auth;
  return auth?.kind === 'session' ? { userId: auth.userId, sessionId: auth.sessionId } : undefined;
}

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
    path: '/',
    summary: 'List organizations',
    query: OrgListQuerySchema,
    response: PlatformOrgListSchema,
  },
  async (c) => {
    const page = await listOrgs(serviceContext(c), c.req.valid('query'), modeOf(c.var.auth));
    return c.json({ ...page, items: page.items.map((org) => PlatformOrgSummarySchema.parse(org)) });
  },
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
    c.json(
      await createOrg(serviceContext(c), requestActor(c), c.req.valid('json'), adminOf(c)),
      201,
    ),
);
register(
  orgsRoutes,
  'orgs',
  {
    method: 'get',
    path: '/{id}',
    summary: 'Get an organization for platform provisioning',
    params: IdParamSchema,
    response: PlatformOrgSummarySchema,
  },
  async (c) =>
    c.json(
      PlatformOrgSummarySchema.parse(
        await getOrg(serviceContext(c), c.req.valid('param').id, modeOf(c.var.auth)),
      ),
    ),
);
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
    return c.json(await updateOrg(serviceContext(c), requestActor(c), id, input, authority));
  },
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
    response: PlatformOrgSummarySchema,
  },
  async (c) => {
    const ctx = serviceContext(c);
    const id = c.req.valid('param').id;
    await setOrgStatus(ctx, requestActor(c), id, c.req.valid('json').status, adminOf(c));
    return c.json(PlatformOrgSummarySchema.parse(await getOrg(ctx, id, modeOf(c.var.auth))));
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
    await deleteOrg(serviceContext(c), requestActor(c), c.req.valid('param').id, adminOf(c));
    return c.json({ ok: true });
  },
);
