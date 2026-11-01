import type { Context } from 'hono';
import { writeEvent } from '../../platform/analytics.ts';
import { SESSION_COOKIE } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { envString } from '../../platform/env.ts';
import { AppError, NotFoundError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { clientIp, enforceRateLimit } from '../../platform/rate-limit.ts';
import { type ServiceContext, serviceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { ipPrefix, readCookie, setSessionCookie } from './cookies.ts';
import { bumpCounter } from './magic-repo.ts';
import { nextOrHome, safeNext } from './next.ts';
import { breakglassPage } from './pages.ts';
import { signInBreakglass } from './service.ts';

const HASH = /^[0-9a-f]{64}$/;

/** Unset or malformed hash means the feature is off; respond as if the route does not exist. */
function configuredHash(c: Context<AppBindings>): string {
  const value = envString(c.env, 'BREAKGLASS_TOKEN_SHA256') ?? '';
  const hash = value.trim().toLowerCase();
  if (!HASH.test(hash)) throw new NotFoundError();
  return hash;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILURE_ROWS_PER_HOUR = 100;

/** Audits a wrong token, capped per hour so guessing cannot flood the log; the day count is exact. */
async function recordFailure(ctx: ServiceContext, prefix: string | null): Promise<void> {
  const now = ctx.clock.now();
  await bumpCounter(ctx.env.DB, 'breakglass:fail', now - (now % DAY));
  const rows = await bumpCounter(ctx.env.DB, 'audit:breakglass_failed', now - (now % HOUR));
  if (rows > FAILURE_ROWS_PER_HOUR + 1) return;
  if (rows === FAILURE_ROWS_PER_HOUR + 1) {
    ctx.log.error('auth.breakglass_failed_capped', { code: 'BREAKGLASS_FAILURE_CAP' });
    return;
  }
  await recordAudit(ctx, {
    actorType: 'system',
    action: 'auth.breakglass_failed',
    ipPrefix: prefix,
    detail: { reason: 'wrong_token' },
  });
}

/** GET /auth/breakglass */
export function breakglassForm(c: Context<AppBindings>) {
  configuredHash(c);
  const next = safeNext(c.req.query('next')) ?? undefined;
  return c.html(breakglassPage(c.var.nonce, { next }));
}

/** POST /auth/breakglass (form post from the page above). */
export async function breakglassSignIn(c: Context<AppBindings>) {
  const expected = configuredHash(c);
  const ctx = serviceContext(c);
  const ip = clientIp(c);
  await enforceRateLimit(c.env, 'RL_LOGIN', `breakglass:${ip}`);
  const form = await c.req.parseBody();
  const token = typeof form.token === 'string' ? form.token.trim() : '';
  const next = safeNext(typeof form.next === 'string' ? form.next : undefined) ?? undefined;
  const ok =
    token.length > 0 && token.length <= 256 && (await safeEqual(await sha256Hex(token), expected));
  if (!ok) {
    ctx.log.warn('auth.breakglass_failed', { ipPrefix: ipPrefix(ip) });
    await recordFailure(ctx, ipPrefix(ip));
    writeEvent(c.env, { event: 'auth.sign_in', outcome: 'breakglass_failed' });
    return c.html(breakglassPage(c.var.nonce, { error: 'Wrong token.', next }), 401);
  }
  try {
    const result = await signInBreakglass(ctx, {
      ipPrefix: ipPrefix(ip),
      userAgent: c.req.header('user-agent') ?? null,
      previousCookie: readCookie(c, SESSION_COOKIE),
      bindingHash: null,
      next: next ?? null,
    });
    ctx.log.warn('auth.breakglass_used', { userId: result.userId, ipPrefix: ipPrefix(ip) });
    setSessionCookie(c, result.session.cookieValue, result.session.maxAgeSeconds);
    return c.redirect(next ? nextOrHome(next) : '/admin', 302);
  } catch (cause) {
    if (cause instanceof AppError && cause.code === 'BREAKGLASS_DISABLED') {
      return c.html(
        breakglassPage(c.var.nonce, { error: 'Break-glass sign-in is disabled.' }),
        403,
      );
    }
    throw cause;
  }
}
