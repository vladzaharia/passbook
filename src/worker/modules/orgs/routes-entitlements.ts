import {
  OrgEntitlementsParamsSchema,
  OrgEntitlementsSchema,
  OrgOwnEntitlementsSchema,
  SetOrgEntitlementsSchema,
} from '../../../shared/contracts/entitlement-admin.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, register } from '../../platform/openapi.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { authOf, tenantAuthorityOf } from '../passes/http.ts';
import {
  readOrgEntitlements,
  readOwnEntitlements,
  setOrgEntitlements,
} from './service-entitlements.ts';

const noStore = async (
  c: { header: (name: string, value: string) => void },
  next: () => Promise<void>,
) => {
  await next();
  c.header('cache-control', 'no-store');
};

/**
 * Mount at /api/v1/platform. What an organization may use: only a platform admin reads the whole state (with
 * the other presets and the notes) and writes it. Entitlements are never writable by the org itself.
 */
export const platformEntitlementsRoutes = createRouter();
platformEntitlementsRoutes.use('*', noStore);

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/orgs/{id}/entitlements',
    summary: "Read an organization's features: preset, overrides and the presets to choose from",
    params: OrgEntitlementsParamsSchema,
    response: OrgEntitlementsSchema,
    auth: { platform: 'platform:orgs' },
  },
  async (c) => c.json(await readOrgEntitlements(serviceContext(c), c.req.valid('param').id)),
);

register(
  platformEntitlementsRoutes,
  'entitlements',
  {
    method: 'put',
    path: '/orgs/{id}/entitlements',
    summary: "Set an organization's preset and overrides, against the revision the caller read",
    params: OrgEntitlementsParamsSchema,
    body: SetOrgEntitlementsSchema,
    response: OrgEntitlementsSchema,
    auth: { platform: 'platform:orgs' },
  },
  async (c) => {
    const auth = authOf(c);
    if (auth.kind !== 'session') throw new UnauthenticatedError();
    return c.json(
      await setOrgEntitlements(
        serviceContext(c),
        requestActor(c),
        c.req.valid('param').id,
        c.req.valid('json'),
        { userId: auth.userId, sessionId: auth.sessionId },
      ),
    );
  },
);

/** Mount at /api/v1/orgs. An organization's admins and `org:read` keys see their own features, read-only. */
export const orgEntitlementsRoutes = createRouter();
orgEntitlementsRoutes.use('*', noStore);

register(
  orgEntitlementsRoutes,
  'entitlements',
  {
    method: 'get',
    path: '/{id}/entitlements',
    summary: "Read the organization's own features",
    params: OrgEntitlementsParamsSchema,
    response: OrgOwnEntitlementsSchema,
    auth: { scope: 'org:read', capability: 'org:read' },
  },
  async (c) => {
    const { id } = c.req.valid('param');
    const ctx = serviceContext(c);
    const authority = await tenantAuthorityOf(ctx, authOf(c), id, 'org:read');
    if (authority.orgId !== id) throw new ForbiddenError();
    return c.json(await readOwnEntitlements(ctx, id));
  },
);
