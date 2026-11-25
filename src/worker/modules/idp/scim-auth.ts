import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { bump } from '../../platform/counters.ts';
import { envString } from '../../platform/env.ts';
import { NotFoundError, RateLimitedError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { checkRateLimit, clientIp, clientRatePrefix } from '../../platform/rate-limit.ts';

/** A token shorter than this is a misconfiguration: the receiver stays off rather than accept a guessable one. */
const MIN_TOKEN = 32;
const MAX_TOKEN = 512;
/** Requests a minute from every caller that proved the token. Polaris ID pushes one resource per request. */
export const SCIM_REQUESTS_PER_MINUTE = 600;
const MINUTE = 60_000;

const bearerOf = (header: string | undefined): string | null => {
  const m = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return m?.[1] && m[1].length <= MAX_TOKEN ? m[1] : null;
};

/**
 * Bearer check for `/scim/v2` (design 1 section 5.9). Unset or short `SCIM_BEARER_TOKEN` answers 404, as if the
 * route did not exist. The compare is `safeEqual`, over digests, so neither the token nor its length leaks, and
 * it comes first: a right token never meets the miss limit, so nobody sharing Polaris ID's network prefix (it
 * leaves from shared Cloudflare addresses) can turn its pushes away by sending wrong ones. A right token spends
 * the receiver's own minute budget. A wrong one is charged to the Workers limiter (`RL_PUBLIC`, by network
 * prefix, no D1), which is cost control only: the secret is long and random.
 */
export const scimAuth = createMiddleware<AppBindings>(async (c, next) => {
  const secret = envString(c.env, 'SCIM_BEARER_TOKEN');
  if (!secret || secret.length < MIN_TOKEN) throw new NotFoundError();
  const now = c.var.clock.now();
  const window = Math.floor(now / MINUTE) * MINUTE;
  const retry = Math.max(Math.ceil((window + MINUTE - now) / 1000), 1);
  const token = bearerOf(c.req.header('authorization'));
  if (token !== null && (await safeEqual(token, secret))) {
    if ((await bump(c.env.DB, 'idp:scim:requests', window)) > SCIM_REQUESTS_PER_MINUTE)
      throw new RateLimitedError(retry);
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
