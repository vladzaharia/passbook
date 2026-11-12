import type { Context } from 'hono';
import {
  SettingsImpactSchema,
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from '../../../shared/contracts/index.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { requestActor } from '../audit/http.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { orgIdOfScope } from './registry.ts';
import { listSettings, settingsImpact, settingsRevision, updateSettings } from './service.ts';

const ScopedSettingsListSchema = SettingsListSchema.extend({
  oidc: SettingsListSchema.shape.oidc.optional(),
});

export const settingsRoutes = createRouter();
guard(settingsRoutes, requireTenantSession);

async function scopeAuthority(
  c: Context<AppBindings>,
  ctx: ServiceContext,
  scope: string,
  capability: 'org:read' | 'org:manage',
) {
  if (scope === 'platform') {
    await requireAdmin(c, async () => {});
    return undefined;
  }
  const orgId = orgIdOfScope(scope);
  if (!orgId) throw new ForbiddenError();
  const auth = c.var.auth;
  if (auth?.kind !== 'session') throw new UnauthenticatedError();
  const authority = await tenantAuthorityOf(ctx, auth, orgId, capability);
  if (authority.kind !== 'session') throw new ForbiddenError();
  return authority;
}

function oidcInfo(c: Context<AppBindings>) {
  return {
    issuer: c.env.OIDC_ISSUER,
    adminGroup: c.env.OIDC_ADMIN_GROUP || null,
    userGroup: c.env.OIDC_USER_GROUP || null,
  };
}

register(
  settingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/',
    summary: 'Read settings',
    query: SettingsListQuerySchema,
    response: ScopedSettingsListSchema,
  },
  async (c) => {
    const { scope } = c.req.valid('query');
    const ctx = serviceContext(c);
    await scopeAuthority(c, ctx, scope, 'org:read');
    const items = await listSettings(ctx, scope);
    return c.json({
      items,
      ...(await settingsRevision(ctx, scope)),
      ...(scope === 'platform' ? { oidc: oidcInfo(c) } : {}),
    });
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'put',
    path: '/',
    summary: 'Update settings',
    body: UpdateSettingsSchema,
    response: ScopedSettingsListSchema,
  },
  async (c) => {
    const input = c.req.valid('json');
    const ctx = serviceContext(c);
    const authority = await scopeAuthority(c, ctx, input.scope, 'org:manage');
    const auth = c.var.auth;
    // requireAdmin already proved a live admin session; the platform grant re-checks it at commit.
    const admin =
      input.scope === 'platform' && auth?.kind === 'session'
        ? { userId: auth.userId, sessionId: auth.sessionId }
        : undefined;
    const items = await updateSettings(ctx, requestActor(c), input, authority, admin);
    return c.json({
      items,
      ...(await settingsRevision(ctx, input.scope)),
      ...(input.scope === 'platform' ? { oidc: oidcInfo(c) } : {}),
    });
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/impact',
    summary: 'Users who sign in by email only',
    response: SettingsImpactSchema,
  },
  async (c) => {
    await requireAdmin(c, async () => {});
    return c.json(await settingsImpact(serviceContext(c)));
  },
);
