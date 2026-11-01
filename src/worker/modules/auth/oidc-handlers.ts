import type { Context } from 'hono';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { baseUrl, envString } from '../../platform/env.ts';
import { AppError, UnavailableError, UpstreamError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import type { HostedArt } from '../../ssr/hosted.ts';
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
import { nextOrHome, safeNext } from './next.ts';
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
import { messagePage, noAccessPage, SIGN_IN_ERRORS } from './pages.ts';
import * as repo from './repo.ts';

const FLOW_TTL_MS = 10 * 60 * 1000;

/** Null when the Pocket ID client is not configured. */
export function oidcConfig(env: AppBindings['Bindings']): RelyingParty | null {
  const issuer = envString(env, 'OIDC_ISSUER');
  const clientId = envString(env, 'OIDC_CLIENT_ID');
  const clientSecret = envString(env, 'OIDC_CLIENT_SECRET');
  if (!issuer || !clientId || !clientSecret) return null;
  const host = new URL(env.PUBLIC_BASE_URL).hostname;
  return issuerRelyingParty({
    issuer,
    clientId,
    clientSecret,
    allowLoopbackHttp: host === 'localhost' || host === '127.0.0.1',
  });
}

const redirectUri = (env: AppBindings['Bindings']) => `${baseUrl(env)}/auth/oidc/callback`;

function errorPage(
  c: Context<AppBindings>,
  title: string,
  message: string,
  status: 400 | 403 | 502,
  art?: HostedArt,
) {
  return c.html(
    messagePage(c.var.nonce, {
      title,
      message,
      href: '/login',
      action: 'Back to sign in',
      ...(art ? { art } : {}),
    }),
    status,
  );
}

/** GET /auth/no-access: where a Polaris ID without Wallet access lands (a clean URL). */
export function noAccess(c: Context<AppBindings>) {
  return c.html(noAccessPage(c.var.nonce));
}

export async function startOidc(c: Context<AppBindings>) {
  await enforceRateLimit(c.env, 'RL_LOGIN', `oidc:${clientIp(c)}`);
  const rp = oidcConfig(c.env);
  if (!rp) throw new UnavailableError('Sign-in is not configured.', 'OIDC_UNCONFIGURED');
  const ctx = serviceContext(c);
  let discovered: Awaited<ReturnType<typeof discover>>;
  try {
    discovered = await discover(rp);
  } catch (error) {
    ctx.log.error('auth.oidc_discovery_failed', { error });
    throw new UpstreamError('Sign-in provider is unreachable.', 'OIDC_UNREACHABLE');
  }
  const secrets = await newFlowSecrets();
  const binding = ctx.ids.token(32);
  await repo.insertFlow(c.env.DB, {
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
      redirectUri: redirectUri(c.env),
      scope: 'openid email profile groups',
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
  if (error || !code || !state || !binding) {
    return errorPage(c, 'Sign-in failed', 'Sign-in was cancelled or refused. Try again.', 400);
  }
  const rp = oidcConfig(c.env);
  if (!rp) throw new UnavailableError('Sign-in is not configured.', 'OIDC_UNCONFIGURED');

  const flow = await repo.consumeFlow(
    c.env.DB,
    await sha256Hex(state),
    await sha256Hex(binding),
    ctx.clock.now(),
  );
  if (!flow) return errorPage(c, 'Sign-in expired', 'Start again.', 400);

  let claims: Record<string, unknown>;
  try {
    ({ claims } = await redeemAuthorizationCode(rp, {
      code,
      iss: iss ?? null,
      redirectUri: redirectUri(c.env),
      codeVerifier: flow.code_verifier,
      nonce: flow.nonce,
    }));
  } catch (cause) {
    if (cause instanceof OidcNetworkError) {
      ctx.log.error('auth.oidc_network', { error: cause });
      return errorPage(c, 'Sign-in unavailable', 'The sign-in provider failed. Try again.', 502);
    }
    if (cause instanceof OidcVerifyError || cause instanceof OidcGrantRefusedError) {
      ctx.log.warn('auth.oidc_rejected', { code: 'OIDC_REJECTED', error: cause });
      return errorPage(c, 'Sign-in failed', 'The sign-in could not be verified. Try again.', 400);
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
        next: flow.redirect_path,
      },
    );
    setSessionCookie(c, result.session.cookieValue, result.session.maxAgeSeconds);
    return c.redirect(nextOrHome(flow.redirect_path), 302);
  } catch (cause) {
    const known = cause instanceof AppError ? SIGN_IN_ERRORS[cause.code] : undefined;
    if (!known) throw cause;
    ctx.log.info('auth.oidc_refused', { code: (cause as AppError).code });
    if ((cause as AppError).code === 'EMAIL_PROOF_SENT') {
      setBindingCookie(c, MAGIC_COOKIE, proofBinding, MAGIC_TTL_MS / 1000);
    }
    if ((cause as AppError).code === 'NO_ACCESS') return c.redirect('/auth/no-access', 303);
    return errorPage(c, known.title, known.message, known.status, known.art);
  }
}
