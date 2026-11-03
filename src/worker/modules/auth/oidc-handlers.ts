import type { Context } from 'hono';
import { isSignInErrorCode, type OidcFailure } from '../../../shared/copy/sign-in.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { envString } from '../../platform/env.ts';
import { AppError, UnavailableError, UpstreamError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import {
  clearCookie,
  ipPrefix,
  MAGIC_COOKIE,
  OIDC_COOKIE,
  readCookie,
  setBindingCookie,
  setSessionCookie,
} from './cookies.ts';
import { MAGIC_TTL_MS } from './magic-service.ts';
import { homeFor, safeNext } from './next.ts';
import { OIDC_SCOPE, oidcRedirectUri, usesCimd } from './oidc-cimd.ts';
import {
  authorizationUrl,
  discover,
  issuerRelyingParty,
  newFlowSecrets,
  OidcGrantRefusedError,
  OidcNetworkError,
  OidcVerifyError,
  type RelyingParty,
  redeemAuthorizationCode,
} from './oidc-client.ts';
import { signInOidc } from './oidc-sign-in.ts';
import { noAccessPage, oidcFailurePage, signInErrorPage } from './pages.ts';
import { saveOidcFlow, takeOidcFlow } from './service.ts';

const FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Null when the Pocket ID client is not configured. The secret is optional: a CIMD client is
 * always public, and a registered client may be public too (PKCE either way).
 */
export function oidcConfig(env: AppBindings['Bindings']): RelyingParty | null {
  const issuer = envString(env, 'OIDC_ISSUER');
  const clientId = envString(env, 'OIDC_CLIENT_ID');
  if (!issuer || !clientId) return null;
  const clientSecret = usesCimd(env) ? null : (envString(env, 'OIDC_CLIENT_SECRET') ?? null);
  const host = new URL(env.PUBLIC_BASE_URL).hostname;
  return issuerRelyingParty({
    issuer,
    clientId,
    clientSecret,
    allowLoopbackHttp: host === 'localhost' || host === '127.0.0.1',
  });
}

/** A failed round trip: one line and a way back to sign-in that keeps next. */
function errorPage(
  c: Context<AppBindings>,
  failure: OidcFailure,
  status: 400 | 502,
  next: string | null,
) {
  return c.html(oidcFailurePage(c.var.nonce, failure, next, requestTheme(c)), status);
}

/** GET /auth/no-access: where a Polaris ID without PassBook access lands (a clean URL). */
export function noAccess(c: Context<AppBindings>) {
  return c.html(noAccessPage(c.var.nonce, safeNext(c.req.query('next')), requestTheme(c)));
}

export async function startOidc(c: Context<AppBindings>) {
  await enforceRateLimit(c.env, 'RL_LOGIN', `oidc:${clientIp(c)}`);
  const rp = oidcConfig(c.env);
  if (!rp) throw new UnavailableError('Sign-in is not configured.', 'OIDC_UNCONFIGURED');
  const ctx = serviceContext(c);
  let discovered: Awaited<ReturnType<typeof discover>>;
  try {
    discovered = await discover(rp, { nowMs: ctx.clock.now(), log: ctx.log });
  } catch (error) {
    ctx.log.error('auth.oidc_discovery_failed', { error });
    throw new UpstreamError('Sign-in provider is unreachable.', 'OIDC_UNREACHABLE');
  }
  const secrets = await newFlowSecrets();
  const binding = ctx.ids.token(32);
  await saveOidcFlow(ctx, {
    stateHash: await sha256Hex(secrets.state),
    nonce: secrets.nonce,
    verifier: secrets.verifier,
    redirectPath: safeNext(c.req.query('next')),
    bindingHash: await sha256Hex(binding),
    expiresAt: ctx.clock.now() + FLOW_TTL_MS,
  });
  setBindingCookie(c, OIDC_COOKIE, binding, FLOW_TTL_MS / 1000);
  return c.redirect(
    authorizationUrl(discovered, rp, {
      redirectUri: oidcRedirectUri(c.env),
      scope: OIDC_SCOPE,
      state: secrets.state,
      nonce: secrets.nonce,
      codeChallenge: secrets.challenge,
      // "Use another Polaris ID" (/auth/no-access) asks the provider to sign in again.
      ...(c.req.query('prompt') === 'login' ? { prompt: 'login' as const } : {}),
    }),
    302,
  );
}

export async function callbackOidc(c: Context<AppBindings>) {
  await enforceRateLimit(c.env, 'RL_LOGIN', `oidc:${clientIp(c)}`);
  const ctx = serviceContext(c);
  const { code, state, iss, error } = c.req.query();
  const binding = readCookie(c, OIDC_COOKIE);
  clearCookie(c, OIDC_COOKIE);
  if (!state || !binding) return errorPage(c, 'cancelled', 400, null);
  const rp = oidcConfig(c.env);
  if (!rp) throw new UnavailableError('Sign-in is not configured.', 'OIDC_UNCONFIGURED');

  const flow = await takeOidcFlow(ctx, await sha256Hex(state), await sha256Hex(binding));
  if (!flow) return errorPage(c, 'expired', 400, null);
  const next = flow.redirect_path;
  if (error || !code) return errorPage(c, 'cancelled', 400, next);

  let claims: Record<string, unknown>;
  try {
    ({ claims } = await redeemAuthorizationCode(
      rp,
      {
        code,
        iss: iss ?? null,
        redirectUri: oidcRedirectUri(c.env),
        codeVerifier: flow.code_verifier,
        nonce: flow.nonce,
      },
      { nowMs: ctx.clock.now(), log: ctx.log },
    ));
  } catch (cause) {
    if (cause instanceof OidcNetworkError) {
      ctx.log.error('auth.oidc_network', { error: cause });
      return errorPage(c, 'unavailable', 502, next);
    }
    if (cause instanceof OidcVerifyError || cause instanceof OidcGrantRefusedError) {
      ctx.log.warn('auth.oidc_rejected', { code: 'OIDC_REJECTED', error: cause });
      return errorPage(c, 'unverified', 400, next);
    }
    throw cause;
  }

  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const proofBinding = ctx.ids.token(32);
  try {
    const result = await signInOidc(
      ctx,
      {
        sub: String(claims.sub),
        email: typeof claims.email === 'string' ? claims.email : undefined,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        emailVerified: claims.email_verified === true,
        groups,
      },
      {
        ipPrefix: ipPrefix(clientIp(c)),
        userAgent: c.req.header('user-agent') ?? null,
        previousCookie: readCookie(c, SESSION_COOKIE),
        bindingHash: await sha256Hex(proofBinding),
        next,
      },
    );
    setSessionCookie(c, result.session.cookieValue, result.session.maxAgeSeconds);
    return c.redirect(homeFor(result.roles, next), 302);
  } catch (cause) {
    if (!(cause instanceof AppError) || !isSignInErrorCode(cause.code)) throw cause;
    ctx.log.info('auth.oidc_refused', { code: cause.code });
    if (cause.code === 'EMAIL_PROOF_SENT') {
      setBindingCookie(c, MAGIC_COOKIE, proofBinding, MAGIC_TTL_MS / 1000);
    }
    if (cause.code === 'NO_ACCESS') {
      const keep = safeNext(next);
      return c.redirect(`/auth/no-access${keep ? `?next=${encodeURIComponent(keep)}` : ''}`, 303);
    }
    const page = signInErrorPage(c.var.nonce, cause.code, { next }, requestTheme(c));
    return c.html(page.html, page.status);
  }
}
