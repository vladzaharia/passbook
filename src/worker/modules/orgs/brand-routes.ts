import type { Context } from 'hono';
import {
  BrandKitSchema,
  BrandOrgQuerySchema,
  DeleteWebLogoQuerySchema,
  UpdateBrandKitSchema,
  UploadWebLogoSchema,
} from '../../../shared/contracts/brand.ts';
import { OrgSchema } from '../../../shared/contracts/orgs.ts';
import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { limitBody } from '../../platform/body-limit.ts';
import { type AppBindings, actorOf } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError, ValidationError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { ownUse } from '../../platform/router-scope.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requireTenantSessionOrApiKey, tenantAuthorityOf } from '../passes/http.ts';
import { brandKitOf } from './brand.ts';
import { deleteWebLogo, putWebLogo, updateBrandKit } from './brand-web.ts';
import { assertSharedWrite } from './shared-write.ts';

/**
 * /api/v1/brand: the org's brand kit. A key needs `brand:manage`; a session needs `org:read` to
 * view and `org:manage` to change. An org-bound key may omit `orgId`.
 */
export const brandRoutes = createRouter();
guard(brandRoutes, requireTenantSessionOrApiKey(['brand:manage']));
// One PNG of at most 512 KB, base64, plus JSON overhead.
ownUse(brandRoutes, limitBody(1024 * 1024));

function orgOf(auth: AuthContext | undefined, requested: string | undefined): string {
  if (!auth) throw new UnauthenticatedError();
  if (auth.kind === 'api_key' && auth.orgId !== null) {
    if (requested !== undefined) assertOrgAccess(auth, requested);
    return auth.orgId;
  }
  if (requested === undefined)
    throw new ValidationError('Invalid request.', [
      { path: 'orgId', message: 'Required', code: 'invalid_type' },
    ]);
  return requested;
}

async function authorize(
  c: Context<AppBindings>,
  requested: string | undefined,
  capability: 'org:read' | 'org:manage',
) {
  const auth = c.var.auth;
  const orgId = orgOf(auth, requested);
  if (!auth || auth.kind === 'scanner') throw new ForbiddenError();
  assertOrgAccess(auth, orgId);
  const ctx = serviceContext(c);
  return { orgId, authority: await tenantAuthorityOf(ctx, auth, orgId, capability) };
}

/** A brand write: `org:manage`, and never from a Test key that shares the org with Live. */
async function authorizeWrite(c: Context<AppBindings>, requested: string | undefined) {
  const found = await authorize(c, requested, 'org:manage');
  await assertSharedWrite(serviceContext(c), found.authority, found.orgId, 'the brand kit');
  return found;
}

register(
  brandRoutes,
  'brand',
  {
    method: 'get',
    path: '/',
    summary: 'Get the brand kit',
    query: BrandOrgQuerySchema,
    response: BrandKitSchema,
  },
  async (c) => {
    const { orgId } = await authorize(c, c.req.valid('query').orgId, 'org:read');
    return c.json(await brandKitOf(serviceContext(c), orgId));
  },
);
register(
  brandRoutes,
  'brand',
  {
    method: 'patch',
    path: '/',
    summary: 'Set the accent color and mark level',
    query: BrandOrgQuerySchema,
    body: UpdateBrandKitSchema,
    response: OrgSchema,
  },
  async (c) => {
    const { orgId, authority } = await authorizeWrite(c, c.req.valid('query').orgId);
    return c.json(
      await updateBrandKit(
        serviceContext(c),
        actorOf(c.var.auth),
        orgId,
        c.req.valid('json'),
        authority,
      ),
    );
  },
);
register(
  brandRoutes,
  'brand',
  {
    method: 'put',
    path: '/web-logo',
    summary: 'Upload the web logo (PNG, at most 1024 by 512 px and 512 KB)',
    query: BrandOrgQuerySchema,
    body: UploadWebLogoSchema,
    response: OrgSchema,
  },
  async (c) => {
    const { orgId, authority } = await authorizeWrite(c, c.req.valid('query').orgId);
    return c.json(
      await putWebLogo(
        serviceContext(c),
        actorOf(c.var.auth),
        orgId,
        c.req.valid('json'),
        authority,
      ),
    );
  },
);
register(
  brandRoutes,
  'brand',
  {
    method: 'delete',
    path: '/web-logo',
    summary: 'Remove the web logo',
    query: DeleteWebLogoQuerySchema,
    response: OrgSchema,
  },
  async (c) => {
    const query = c.req.valid('query');
    const { orgId, authority } = await authorizeWrite(c, query.orgId);
    return c.json(
      await deleteWebLogo(
        serviceContext(c),
        actorOf(c.var.auth),
        orgId,
        query.configRevision,
        authority,
      ),
    );
  },
);
