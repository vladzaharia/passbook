import type { Context } from 'hono';
import type { SessionResponse } from '../../../shared/contracts/index.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { clientIp } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { clearSessionCookie, ipPrefix, readCookie } from './cookies.ts';
import { postLogoutRedirectUri } from './oidc-cimd.ts';
import { discover } from './oidc-client.ts';
import { oidcConfig } from './oidc-handlers.ts';
import { findUser } from './service.ts';
import { revokeOne } from './sessions.ts';

/** GET /api/v1/session. Never 401: signed-out callers get what the login page needs. */
export async function getSession(c: Context<AppBindings>): Promise<SessionResponse> {
  const ctx = serviceContext(c);
  const cookie = readCookie(c, SESSION_COOKIE);
  const auth = cookie ? await c.var.stores.sessions.resolve(cookie) : null;
  const user = auth ? await findUser(ctx, auth.userId) : null;
  if (auth && user) {
    const expiresAt = 'expiresAt' in auth ? Number(auth.expiresAt) : ctx.clock.now();
    return {
      authenticated: true,
      user: { id: user.id, name: user.name, primaryEmail: user.primary_email },
      roles: auth.roles,
      csrfToken: auth.csrfSecret,
      amr: auth.amr,
      expiresAt,
    };
  }
  const settings = await getPlatformSettings(ctx);
  return {
    authenticated: false,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    oidcEnabled: oidcConfig(c.env) !== null,
    magicLinkEnabled: settings['auth.magicLinkEnabled'],
  };
}

async function endSessionUrl(c: Context<AppBindings>): Promise<string | null> {
  const rp = oidcConfig(c.env);
  if (!rp) return null;
  try {
    const ctx = serviceContext(c);
    const { endSessionEndpoint } = await discover(rp, { nowMs: ctx.clock.now(), log: ctx.log });
    if (!endSessionEndpoint) return null;
    const url = new URL(endSessionEndpoint);
    url.searchParams.set('client_id', rp.clientId);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri(c.env));
    return url.toString();
  } catch (error) {
    c.var.log.warn('auth.oidc_logout_discovery_failed', { error });
    return null;
  }
}

/** POST /auth/logout. Revokes the session, then leaves via Pocket ID when it supports it. */
export async function logout(c: Context<AppBindings>) {
  const ctx = serviceContext(c);
  const cookie = readCookie(c, SESSION_COOKIE);
  const auth = cookie ? await c.var.stores.sessions.resolve(cookie) : null;
  let target = '/login';
  if (auth) {
    await revokeOne(ctx, auth.sessionId);
    await recordAudit(ctx, {
      actorType: 'user',
      actorId: auth.userId,
      action: 'auth.sign_out',
      targetType: 'user',
      targetId: auth.userId,
      ipPrefix: ipPrefix(clientIp(c)),
    });
    if (auth.amr === 'oidc') target = (await endSessionUrl(c)) ?? target;
  }
  clearSessionCookie(c);
  if (c.req.header('accept')?.includes('application/json')) {
    return c.json({ ok: true as const, redirect: target });
  }
  return c.redirect(target, 303);
}
