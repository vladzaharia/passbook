import type { Context } from 'hono';
import {
  SettingsImpactSchema,
  SettingsListQuerySchema,
  SettingsListSchema,
  UpdateSettingsSchema,
} from '../../../shared/contracts/index.ts';
import {
  ReplyToConfirmSchema,
  ReplyToOrgSchema,
  ReplyToStatusSchema,
} from '../../../shared/contracts/settings.ts';
import { requireAdmin } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import { createRouter, guard, register } from '../../platform/openapi.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { peekBody, requireStepUp, STEP_UP_SECONDS } from '../../platform/sign-in-guard.ts';
import { requestActor } from '../audit/http.ts';
import { configuredNames } from '../auth/service.ts';
import { confirmReplyTo, replyToStatus, resendReplyTo, syncReplyTo } from '../delivery/reply-to.ts';
import { requireTenantSession, tenantAuthorityOf } from '../passes/http.ts';
import { walletProviderEnabled } from '../wallet-providers/provider-policy.ts';
import { orgIdOfScope } from './registry.ts';
import { listSettings, settingsImpact, settingsRevision, updateSettings } from './service.ts';
import { changesSignIn } from './sign-in-settings.ts';

export const ScopedSettingsListSchema = SettingsListSchema.extend({
  oidc: SettingsListSchema.shape.oidc.optional(),
});

export const settingsRoutes = createRouter();
guard(settingsRoutes, requireTenantSession);
// A platform sign-in or account-linking setting (auth.*, oidc.*) reopens or loosens who gets in.
settingsRoutes.put(
  '/',
  requireStepUp(STEP_UP_SECONDS, async (c) => {
    const { scope, values } = await peekBody(c);
    return scope === 'platform' && changesSignIn(values);
  }),
);

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

export function oidcInfo(c: Context<AppBindings>) {
  return {
    issuer: c.env.OIDC_ISSUER,
    platformAdminGroup: configuredNames(c.env, 'OIDC_PLATFORM_ADMIN_GROUP'),
    adminGroup: configuredNames(c.env, 'OIDC_ADMIN_GROUP'),
    developerGroup: configuredNames(c.env, 'OIDC_DEVELOPER_GROUP'),
    userGroup: configuredNames(c.env, 'OIDC_USER_GROUP'),
    platformAdminPinned: configuredNames(c.env, 'OIDC_PLATFORM_ADMIN_SUBJECTS').length,
    consoleGroupRequired: c.env.OIDC_CONSOLE_GROUP_REQUIRED === 'true',
  };
}

export const releaseInfo = () => ({
  google: walletProviderEnabled('google'),
  samsung: walletProviderEnabled('samsung'),
});

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
      ...(scope === 'platform' ? { oidc: oidcInfo(c), released: releaseInfo() } : {}),
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
    const orgId = orgIdOfScope(input.scope);
    if (orgId && 'support.email' in input.values) {
      const support = items.find((item) => item.key === 'support.email')?.value;
      await syncReplyTo(ctx, orgId, typeof support === 'string' ? support : null);
    }
    return c.json({
      items,
      ...(await settingsRevision(ctx, input.scope)),
      ...(input.scope === 'platform' ? { oidc: oidcInfo(c), released: releaseInfo() } : {}),
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

register(
  settingsRoutes,
  'settings',
  {
    method: 'get',
    path: '/reply-to',
    summary: "Whether the org's support address is confirmed as reply-to",
    query: ReplyToOrgSchema,
    response: ReplyToStatusSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('query');
    const ctx = serviceContext(c);
    await scopeAuthority(c, ctx, `org:${orgId}`, 'org:read');
    return c.json(await replyToStatus(ctx, orgId));
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'post',
    path: '/reply-to/resend',
    summary: 'Send the reply-to confirmation link again',
    body: ReplyToOrgSchema,
    response: ReplyToStatusSchema,
  },
  async (c) => {
    const { orgId } = c.req.valid('json');
    const ctx = serviceContext(c);
    await scopeAuthority(c, ctx, `org:${orgId}`, 'org:manage');
    await resendReplyTo(ctx, orgId);
    return c.json(await replyToStatus(ctx, orgId));
  },
);

register(
  settingsRoutes,
  'settings',
  {
    method: 'post',
    path: '/reply-to/confirm',
    summary: 'Confirm the support address as reply-to with the emailed token',
    body: ReplyToConfirmSchema,
    response: ReplyToStatusSchema,
  },
  async (c) => {
    const { orgId, token } = c.req.valid('json');
    const ctx = serviceContext(c);
    await scopeAuthority(c, ctx, `org:${orgId}`, 'org:manage');
    await confirmReplyTo(ctx, orgId, token);
    return c.json(await replyToStatus(ctx, orgId));
  },
);
