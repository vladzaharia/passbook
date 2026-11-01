import type { Context } from 'hono';
import { MagicLinkConsumeSchema, MagicLinkRequestSchema } from '../../../shared/contracts/index.ts';
import { strictEmail } from '../../../shared/email.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import {
  AppError,
  ForbiddenError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import {
  clearCookie,
  ipPrefix,
  MAGIC_COOKIE,
  readCookie,
  setBindingCookie,
  setSessionCookie,
} from './cookies.ts';
import {
  consumeMagicCode,
  consumeMagicToken,
  MAGIC_TTL_MS,
  type MagicOutcome,
  peekMagicLink,
  processSignInRequest,
} from './magic-service.ts';
import { nextOrHome, safeNext } from './next.ts';
import { confirmPage, expiredPage, messagePage, SIGN_IN_ERRORS } from './pages.ts';
import { resolveSession } from './sessions.ts';
import { verifyTurnstile } from './turnstile.ts';

/** POST /auth/magic/request. The body never depends on whether the address is known. */
export async function requestMagic(c: Context<AppBindings>) {
  const ctx = serviceContext(c);
  const ip = clientIp(c);
  await enforceRateLimit(c.env, 'RL_MAGIC_LINK', `ip:${ip}`);
  if (!(await getPlatformSettings(ctx))['auth.magicLinkEnabled']) {
    throw new UnavailableError('Email sign-in is off.', 'MAGIC_LINK_DISABLED');
  }
  const input = MagicLinkRequestSchema.parse(await c.req.json());
  if (!(await verifyTurnstile(c.env, input.turnstileToken, ip, ctx.log))) {
    ctx.log.warn('auth.turnstile_failed', {});
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
        }))(),
    );
  }
  return c.json({ ok: true as const }, 202);
}

/** GET /auth/magic?t=. Reads only; scanners cannot burn the token. */
export async function confirmMagic(c: Context<AppBindings>) {
  const token = c.req.query('t') ?? '';
  const link =
    token.length >= 16 && token.length <= 256
      ? await peekMagicLink(serviceContext(c), token)
      : null;
  if (!link) return c.html(expiredPage(c.var.nonce), 400);
  return c.html(confirmPage(c.var.nonce, { token, ...link }));
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
  await enforceRateLimit(c.env, 'RL_LOGIN', `magic:${clientIp(c)}`);
  const ctx = serviceContext(c);
  const previousCookie = readCookie(c, SESSION_COOKIE);
  const session = previousCookie ? await resolveSession(c.env, ctx.clock, previousCookie) : null;
  const sign = {
    ipPrefix: ipPrefix(clientIp(c)),
    userAgent: c.req.header('user-agent') ?? null,
    previousCookie,
    sessionUserId: session?.userId ?? null,
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

/** POST /auth/magic/consume. Forms get a redirect or an error page; JSON gets JSON. */
export async function consumeMagic(c: Context<AppBindings>) {
  const type = c.req.header('content-type') ?? '';
  const isForm =
    type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
  let outcome: MagicOutcome;
  try {
    outcome = await runConsume(c, await readConsumeBody(c, isForm));
  } catch (error) {
    const known = error instanceof AppError ? SIGN_IN_ERRORS[error.code] : undefined;
    if (!isForm || !known) throw error;
    return c.html(
      known === SIGN_IN_ERRORS.LINK_INVALID
        ? expiredPage(c.var.nonce)
        : messagePage(c.var.nonce, {
            title: known.title,
            message: known.message,
            href: '/login',
            action: 'Back to sign in',
            ...(known.art ? { art: known.art } : {}),
          }),
      known.status,
    );
  }
  if (outcome.kind === 'signed_in') {
    setSessionCookie(c, outcome.result.session.cookieValue, outcome.result.session.maxAgeSeconds);
    clearCookie(c, MAGIC_COOKIE);
  }
  const target =
    outcome.kind === 'verified' ? (safeNext(outcome.next) ?? '/account') : nextOrHome(outcome.next);
  return isForm ? c.redirect(target, 303) : c.json({ ok: true as const, next: target });
}
