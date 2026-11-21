import type { Context } from 'hono';
import { MagicLinkConsumeSchema, MagicLinkRequestSchema } from '../../../shared/contracts/index.ts';
import { isSignInErrorCode, type SignInErrorCode } from '../../../shared/copy/sign-in.ts';
import { strictEmail } from '../../../shared/email.ts';
import { TURNSTILE_ACTION } from '../../../shared/turnstile.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  AppError,
  ForbiddenError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, clientRatePrefix, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { requestTheme } from '../../ssr/head.ts';
import {
  clearCookie,
  ipPrefix,
  MAGIC_COOKIE,
  readCookie,
  setBindingCookie,
  setSessionCookie,
} from './cookies.ts';
import { landingFor } from './landing.ts';
import { magicLinkTrace, peekMagicLink } from './magic-peek.ts';
import {
  consumeMagicCode,
  consumeMagicToken,
  isEmailSignInEnabled,
  MAGIC_TTL_MS,
  type MagicOutcome,
  processSignInRequest,
} from './magic-service.ts';
import { safeNext } from './next.ts';
import { confirmPage, expiredPage, signInErrorPage, signInToConfirm, verifyPage } from './pages.ts';
import { resolveSession } from './sessions.ts';
import { verifyTurnstile } from './turnstile.ts';

/** POST /auth/magic/request. The body never depends on whether the address is known. */
export async function requestMagic(c: Context<AppBindings>) {
  const ctx = serviceContext(c);
  const ip = clientIp(c);
  await enforceRateLimit(c.env, 'RL_MAGIC_LINK', `ip:${clientRatePrefix(c)}`);
  if (!(await isEmailSignInEnabled(ctx))) {
    throw new UnavailableError('Email sign-in is off.', 'MAGIC_LINK_DISABLED');
  }
  const input = MagicLinkRequestSchema.parse(await c.req.json());
  if (!(await verifyTurnstile(c.env, input.turnstileToken, ip, ctx.log, fetch, TURNSTILE_ACTION))) {
    ctx.log.warn('auth.turnstile_failed', { code: 'TURNSTILE_FAILED' });
    throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
  }
  // Stable per browser: a stranger's or repeated request must not orphan an earlier link.
  const existing = readCookie(c, MAGIC_COOKIE);
  const binding = existing && existing.length >= 32 ? existing : ctx.ids.token(32);
  setBindingCookie(c, MAGIC_COOKIE, binding, MAGIC_TTL_MS / 1000);
  const email = strictEmail(input.email);
  if (email) {
    ctx.waitUntil(
      (async () =>
        processSignInRequest(ctx, {
          email,
          bindingHash: await sha256Hex(binding),
          next: safeNext(input.next),
          ipPrefix: ipPrefix(ip),
          prefer: input.prefer ?? 'link',
        }))(),
    );
  }
  return c.json({ ok: true as const }, 202);
}

/** The session this browser presents, if any. */
async function currentSession(c: Context<AppBindings>) {
  const cookie = readCookie(c, SESSION_COOKIE);
  const session = cookie ? await resolveSession(c.env, serviceContext(c).clock, cookie) : null;
  return { cookie, session };
}

/** GET /auth/magic?t=. Reads only; scanners cannot burn the token. */
export async function confirmMagic(c: Context<AppBindings>) {
  const ctx = serviceContext(c);
  const nonce = c.var.nonce;
  const theme = requestTheme(c);
  const token = c.req.query('t') ?? '';
  const link = token.length >= 16 && token.length <= 256 ? await peekMagicLink(ctx, token) : null;
  if (!link) {
    const trace = await magicLinkTrace(ctx, token);
    return c.html(expiredPage(nonce, trace, theme, token, await isEmailSignInEnabled(ctx)), 400);
  }
  if (link.purpose === 'sign_in') {
    if (link.needsEmailSignIn && !(await isEmailSignInEnabled(ctx))) {
      const page = signInErrorPage(nonce, 'MAGIC_LINK_DISABLED', { next: link.next }, theme);
      return c.html(page.html, page.status);
    }
    return c.html(
      confirmPage(nonce, { token, email: link.email, invitation: link.invitation }, theme),
    );
  }
  const { session } = await currentSession(c);
  const viewer = !session ? 'signed-out' : session.userId === link.userId ? 'requester' : 'other';
  return c.html(
    verifyPage(nonce, { token, email: link.email, requester: link.requester, viewer }, theme),
  );
}

async function readConsumeBody(c: Context<AppBindings>, isForm: boolean): Promise<unknown> {
  if (isForm) return Object.fromEntries(await c.req.formData());
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('Invalid request.');
  }
}

async function runConsume(c: Context<AppBindings>, body: unknown): Promise<MagicOutcome> {
  const parsed = MagicLinkConsumeSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid request.');
  await enforceRateLimit(c.env, 'RL_LOGIN', `magic:${clientRatePrefix(c)}`);
  const ctx = serviceContext(c);
  const { cookie: previousCookie, session } = await currentSession(c);
  const sign = {
    ipPrefix: ipPrefix(clientIp(c)),
    userAgent: c.req.header('user-agent') ?? null,
    previousCookie,
    sessionUserId: session?.userId ?? null,
    sessionAmr: session?.amr ?? null,
    sessionRoles: session?.roles,
  };
  const data = parsed.data;
  return 'token' in data
    ? consumeMagicToken(ctx, data.token, sign, readCookie(c, MAGIC_COOKIE))
    : consumeMagicCode(
        ctx,
        { email: data.email, code: data.code, bindingCookie: readCookie(c, MAGIC_COOKIE) },
        sign,
      );
}

/** A refused confirm click: a page that keeps the link's next, never problem+json. */
async function consumeErrorPage(
  c: Context<AppBindings>,
  code: SignInErrorCode,
  error: AppError,
  body: unknown,
) {
  const nonce = c.var.nonce;
  const theme = requestTheme(c);
  const field = (body as Record<string, unknown> | null)?.token;
  const token = typeof field === 'string' ? field : '';
  const trace = await magicLinkTrace(serviceContext(c), token);
  if (code === 'LINK_INVALID') {
    const on = await isEmailSignInEnabled(serviceContext(c));
    return c.html(expiredPage(nonce, trace, theme, token, on), 400);
  }
  for (const [name, value] of Object.entries(error.headers ?? {})) c.header(name, value);
  const opts =
    code === 'SESSION_REQUIRED' && token
      ? { action: signInToConfirm(token) }
      : {
          next: trace?.next ?? null,
          ...(code === 'IDP_EMAIL_NOT_PRIMARY' ? { message: error.message } : {}),
        };
  const page = signInErrorPage(nonce, code, opts, theme);
  return c.html(page.html, page.status);
}

/** Where the browser goes once a link or code is consumed. */
async function targetOf(c: Context<AppBindings>, outcome: MagicOutcome): Promise<string> {
  if (outcome.kind === 'verified') return `/account?verified=${encodeURIComponent(outcome.email)}`;
  if (outcome.kind === 'linked') {
    const next = safeNext(outcome.next);
    return next ? `/auth/oidc/start?next=${encodeURIComponent(next)}` : '/auth/oidc/start';
  }
  if (outcome.kind === 'kept')
    return landingFor(serviceContext(c), outcome.userId, outcome.roles, outcome.next);
  return landingFor(serviceContext(c), outcome.result.userId, outcome.result.roles, outcome.next);
}

/** POST /auth/magic/consume. Forms get a redirect or an error page; JSON gets JSON. */
export async function consumeMagic(c: Context<AppBindings>) {
  const type = c.req.header('content-type') ?? '';
  const isForm =
    type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
  let body: unknown = null;
  let outcome: MagicOutcome;
  try {
    body = await readConsumeBody(c, isForm);
    outcome = await runConsume(c, body);
  } catch (error) {
    const code = error instanceof AppError ? error.code : '';
    if (!isForm || !isSignInErrorCode(code)) throw error;
    return consumeErrorPage(c, code, error as AppError, body);
  }
  if (outcome.kind === 'signed_in') {
    setSessionCookie(c, outcome.result.session.cookieValue, outcome.result.session.maxAgeSeconds);
    clearCookie(c, MAGIC_COOKIE);
  }
  if (outcome.kind === 'linked') clearCookie(c, MAGIC_COOKIE);
  // ?verified= tells /account which address was just added (the portal confirms it).
  const target = await targetOf(c, outcome);
  return isForm ? c.redirect(target, 303) : c.json({ ok: true as const, next: target });
}
