import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { bump } from '../../platform/counters.ts';
import { envString } from '../../platform/env.ts';
import { NotFoundError, RateLimitedError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { checkRateLimit, clientIp, clientRatePrefix } from '../../platform/rate-limit.ts';
import { type ScimTokenRow, touchAuth } from './repo-scim-tokens.ts';
import { dropScimTokenCache, type Snapshot, snapshot } from './scim-cache.ts';
import { PENDING_WINDOW_MS } from './scim-tokens.ts';

/** A token shorter than this is a misconfiguration: the receiver stays off rather than accept a guessable one. */
const MIN_TOKEN = 32;
const MAX_TOKEN = 512;
/** Requests a minute from every caller that proved the token. Polaris ID pushes one resource per request. */
export const SCIM_REQUESTS_PER_MINUTE = 600;
const MINUTE = 60_000;
const FALLBACK_LOG_MS = 3_600_000;

const touched = new Map<string, number>();
let fallbackLoggedAt = 0;

/** Tests only: forget the cached rows and use times. */
export function resetScimTokenCache(): void {
  dropScimTokenCache();
  touched.clear();
  fallbackLoggedAt = 0;
}

type Verdict = { off: true } | { off: false; hit: ScimTokenRow | 'secret' | null };

/**
 * Which credential the bearer proves. A D1 token that is active makes the `SCIM_BEARER_TOKEN` secret inert; a
 * pending one is accepted for its window. With no active token the secret (32 characters or more) still works.
 */
async function judge(
  s: Snapshot,
  secret: string | undefined,
  token: string | null,
  now: number,
): Promise<Verdict> {
  const pending = s.pending && now - s.pending.created_at < PENDING_WINDOW_MS ? s.pending : null;
  const secretUsable = !s.active && !!secret && secret.length >= MIN_TOKEN;
  if (!s.active && !pending && !secretUsable) return { off: true };
  if (token === null) return { off: false, hit: null };
  const hash = await sha256Hex(token);
  for (const row of [s.active, pending])
    if (row && (await safeEqual(hash, row.token_sha256))) return { off: false, hit: row };
  if (secretUsable && secret && (await safeEqual(token, secret)))
    return { off: false, hit: 'secret' };
  return { off: false, hit: null };
}

const bearerOf = (header: string | undefined): string | null => {
  const m = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return m?.[1] && m[1].length <= MAX_TOKEN ? m[1] : null;
};

/**
 * Bearer check for `/scim/v2` (design 1 section 5.9). With no active D1 token, no live pending one and an unset
 * or short `SCIM_BEARER_TOKEN` it answers 404, as if the route did not exist. The compare is `safeEqual` over
 * SHA-256 digests (the token is stored hashed), so neither the token nor its length leaks, and it comes first:
 * a right token never meets the miss limit, so nobody sharing Polaris ID's network prefix (it leaves from shared
 * Cloudflare addresses) can turn its pushes away by sending wrong ones. A right token spends the receiver's own
 * minute budget. A wrong one is charged to the Workers limiter (`RL_PUBLIC`, by network prefix), which is cost
 * control only: the token is long and random. Rows are cached per isolate for 5 s, so a wrong token costs no
 * query per request, a rotation in another isolate is seen within 5 s (this isolate drops its cache on its own
 * activations), and a retired token is refused at most 5 s late.
 */
export const scimAuth = createMiddleware<AppBindings>(async (c, next) => {
  const secret = envString(c.env, 'SCIM_BEARER_TOKEN');
  const now = c.var.clock.now();
  const token = bearerOf(c.req.header('authorization'));
  const db = c.env.DB;
  const verdict = await judge(await snapshot(db, now), secret, token, now);
  if (verdict.off) throw new NotFoundError();
  const window = Math.floor(now / MINUTE) * MINUTE;
  const retry = Math.max(Math.ceil((window + MINUTE - now) / 1000), 1);
  if (verdict.hit !== null) {
    if ((await bump(db, 'idp:scim:requests', window)) > SCIM_REQUESTS_PER_MINUTE)
      throw new RateLimitedError(retry);
    if (verdict.hit === 'secret') {
      if (now - fallbackLoggedAt >= FALLBACK_LOG_MS) {
        fallbackLoggedAt = now;
        c.var.log.warn('idp.scim.secret_fallback', { code: 'SCIM_SECRET_FALLBACK' });
      }
    } else if (now - (touched.get(verdict.hit.id) ?? 0) >= MINUTE) {
      touched.set(verdict.hit.id, now);
      try {
        await touchAuth(db, verdict.hit.id, now);
      } catch {
        c.var.log.warn('idp.scim.touch_failed', { code: 'SCIM_TOUCH_FAILED' });
      }
    }
    await next();
    return;
  }
  if (!(await checkRateLimit(c.env, 'RL_PUBLIC', `scim-miss:${clientRatePrefix(c)}`)))
    throw new RateLimitedError(retry);
  c.var.log.warn('idp.scim.auth_failed', {
    code: 'SCIM_AUTH_FAILED',
    ipPrefix: ipPrefix(clientIp(c)),
  });
  throw new UnauthenticatedError('Invalid token.', 'SCIM_AUTH_FAILED');
});
