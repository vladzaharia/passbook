import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../../platform/context.ts';
import { bump, read } from '../../platform/counters.ts';
import { envString } from '../../platform/env.ts';
import { NotFoundError, RateLimitedError, UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual } from '../../platform/ids.ts';
import { ipPrefix } from '../../platform/ip.ts';
import { clientIp, clientRatePrefix } from '../../platform/rate-limit.ts';

/** A token shorter than this is a misconfiguration: the receiver stays off rather than accept a guessable one. */
const MIN_TOKEN = 32;
const MAX_TOKEN = 512;
/** Requests a minute from every caller that proved the token. Polaris ID pushes one resource per request. */
export const SCIM_REQUESTS_PER_MINUTE = 600;
/** Wrong tokens a network prefix may send in a minute before it is turned away without a compare. */
export const SCIM_REJECTS_PER_MINUTE = 30;
const MINUTE = 60_000;

const bearerOf = (header: string | undefined): string | null => {
  const m = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return m?.[1] && m[1].length <= MAX_TOKEN ? m[1] : null;
};

/**
 * Bearer check for `/scim/v2` (design 1 section 5.9). Unset or short `SCIM_BEARER_TOKEN` answers 404, as if the
 * route did not exist. The compare is `safeEqual`, over digests, so neither the token nor its length leaks.
 * A wrong token costs its network prefix a count; past `SCIM_REJECTS_PER_MINUTE` the prefix gets 429 before any compare.
 * A right one spends the receiver's own minute budget, so a flood from a holder of the token cannot starve D1.
 */
export const scimAuth = createMiddleware<AppBindings>(async (c, next) => {
  const secret = envString(c.env, 'SCIM_BEARER_TOKEN');
  if (!secret || secret.length < MIN_TOKEN) throw new NotFoundError();
  const now = c.var.clock.now();
  const window = Math.floor(now / MINUTE) * MINUTE;
  const retry = Math.max(Math.ceil((window + MINUTE - now) / 1000), 1);
  const missKey = `idp:scim:miss:${clientRatePrefix(c)}`;

  if ((await read(c.env.DB, missKey, window)) >= SCIM_REJECTS_PER_MINUTE)
    throw new RateLimitedError(retry);
  const token = bearerOf(c.req.header('authorization'));
  if (token === null || !(await safeEqual(token, secret))) {
    await bump(c.env.DB, missKey, window);
    c.var.log.warn('idp.scim.auth_failed', {
      code: 'SCIM_AUTH_FAILED',
      ipPrefix: ipPrefix(clientIp(c)),
    });
    throw new UnauthenticatedError('Invalid token.', 'SCIM_AUTH_FAILED');
  }
  if ((await bump(c.env.DB, 'idp:scim:requests', window)) > SCIM_REQUESTS_PER_MINUTE)
    throw new RateLimitedError(retry);
  await next();
});
