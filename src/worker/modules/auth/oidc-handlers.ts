import type { Context } from 'hono';
import { isSignInErrorCode, type OidcFailure } from '../../../shared/copy/sign-in.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { envString } from '../../platform/env.ts';
import { AppError, UnavailableError, UpstreamError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../platform/rate-limit.ts';
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
import { landingFor } from './landing.ts';
import { MAGIC_TTL_MS } from './magic-service.ts';
import { safeNext } from './next.ts';
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
import { noAccessPage, oidcFailurePage, signInErrorPage, stepUpNotFreshPage } from './pages.ts';
import { saveOidcFlow, takeOidcFlow } from './service.ts';

const FLOW_TTL_MS = 10 * 60 * 1000;
/** How far behind the flow's start the provider's clock may run and still count as fresh. */
const STEP_UP_FRESH_SKEW_MS = 2 * 60 * 1000;

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

type Discovered = Awaited<ReturnType<typeof discover>>;

/** Saves a flow and sends the browser to the provider. `retried` marks the one restart for a missing passkey. */
async function beginFlow(
  c: Context<AppBindings>,
  rp: RelyingParty,
  discovered: Discovered,
  input: {
    next: string | null;
    prompt?: 'login';
    maxAge?: 0;
    retried?: boolean;
    stepUpStartedAt?: number;
  },
) {
  const ctx = serviceContext(c);
  const secrets = await newFlowSecrets();
  const binding = ctx.ids.token(32);
  await saveOidcFlow(ctx, {
    stateHash: await sha256Hex(secrets.state),
    nonce: secrets.nonce,
    verifier: secrets.verifier,
    redirectPath: input.next,
    bindingHash: await sha256Hex(binding),
    expiresAt: ctx.clock.now() + FLOW_TTL_MS,
    ...(input.retried ? { retried: true } : {}),
    ...(input.stepUpStartedAt === undefined ? {} : { stepUpStartedAt: input.stepUpStartedAt }),
  });
  setBindingCookie(c, OIDC_COOKIE, binding, FLOW_TTL_MS / 1000);
  return c.redirect(
    authorizationUrl(discovered, rp, {
      redirectUri: oidcRedirectUri(c.env),
      scope: OIDC_SCOPE,
      state: secrets.state,
      nonce: secrets.nonce,
      codeChallenge: secrets.challenge,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.maxAge === 0 ? { maxAge: 0 as const } : {}),
    }),
    302,
  );
}

export async function startOidc(c: Context<AppBindings>) {
  await enforceRateLimit(c.env, 'RL_LOGIN', `oidc:${clientRatePrefix(c)}`);
  const rp = oidcConfig(c.env);
  if (!rp) throw new UnavailableError('Sign-in is not configured.', 'OIDC_UNCONFIGURED');
  const ctx = serviceContext(c);
  let discovered: Discovered;
  try {
    discovered = await discover(rp, { nowMs: ctx.clock.now(), log: ctx.log });
  } catch (error) {
    ctx.log.error('auth.oidc_discovery_failed', { error });
    throw new UpstreamError('Sign-in provider is unreachable.', 'OIDC_UNREACHABLE');
  }
  // "Use another Polaris ID" (/auth/no-access) and a step-up ask the provider to sign in again;
  // max_age=0 makes it re-authenticate and put a new auth_time in the ID token.
  return beginFlow(c, rp, discovered, {
    next: safeNext(c.req.query('next')),
    ...(c.req.query('prompt') === 'login' ? { prompt: 'login' as const } : {}),
    ...(c.req.query('max_age') === '0'
      ? { maxAge: 0 as const, stepUpStartedAt: ctx.clock.now() }
      : {}),
  });
}

export async function callbackOidc(c: Context<AppBindings>) {
  await enforceRateLimit(c.env, 'RL_LOGIN', `oidc:${clientRatePrefix(c)}`);
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
  let discovered: Discovered;
  try {
    ({ claims, discovered } = await redeemAuthorizationCode(
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

  // A Polaris ID session made with an emailed login code (`otp`) is email strength in disguise. The
  // first time, ask again with prompt=login so the person can use their passkey; the second, refuse.
  const needed = envString(c.env, 'OIDC_REQUIRE_AMR');
  const methods = Array.isArray(claims.amr) ? claims.amr : [];
  // No amr at all means the provider does not send it (Pocket ID before 2.19.3), not that the person used a code.
  if (needed && claims.amr === undefined)
    ctx.log.warn('oidc.amr_absent', { code: 'OIDC_AMR_ABSENT' });
  if (needed && !methods.includes(needed)) {
    ctx.log.info('auth.oidc_passkey_missing', {
      code: 'PASSKEY_REQUIRED',
      retried: flow.retried === 1,
    });
    if (flow.retried !== 1)
      return beginFlow(c, rp, discovered, {
        next,
        prompt: 'login',
        retried: true,
        ...(flow.step_up_started_at === null
          ? {}
          : { maxAge: 0 as const, stepUpStartedAt: ctx.clock.now() }),
      });
    const page = signInErrorPage(c.var.nonce, 'PASSKEY_REQUIRED', { next }, requestTheme(c));
    return c.html(page.html, page.status);
  }
  // A step-up must come back from a fresh authentication: a provider that ignored max_age (or an SSO
  // cookie answering without asking) returns an old auth_time, and that is not a step-up.
  if (
    flow.step_up_started_at !== null &&
    !(
      typeof claims.auth_time === 'number' &&
      claims.auth_time * 1000 >= flow.step_up_started_at - STEP_UP_FRESH_SKEW_MS
    )
  ) {
    ctx.log.warn('auth.step_up_not_fresh', { code: 'STEP_UP_NOT_FRESH' });
    return c.html(stepUpNotFreshPage(c.var.nonce, next, requestTheme(c)), 403);
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
        ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time * 1000 } : {}),
      },
    );
    setSessionCookie(c, result.session.cookieValue, result.session.maxAgeSeconds);
    return c.redirect(await landingFor(ctx, result.userId, result.roles, next), 302);
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
    const page = signInErrorPage(
      c.var.nonce,
      cause.code,
      { next, ...(cause.code === 'IDP_EMAIL_NOT_PRIMARY' ? { message: cause.message } : {}) },
      requestTheme(c),
    );
    return c.html(page.html, page.status);
  }
}
