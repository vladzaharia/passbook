import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import { bump, read as readCounter } from './counters.ts';
import type { AppEnv, RateLimitName } from './env.ts';
import { RateLimitedError, UnavailableError } from './errors.ts';
import { ipRatePrefix } from './ip.ts';
import { createLogger } from './log.ts';

const warned = new Set<string>();

export function resetRateLimitWarnings(): void {
  warned.clear();
}

/** True when the request may proceed. A missing binding fails closed with a 503. */
export async function checkRateLimit(
  env: AppEnv,
  name: RateLimitName,
  key: string,
): Promise<boolean> {
  const limiter = env[name] as RateLimit | undefined;
  if (typeof limiter?.limit !== 'function') {
    if (!warned.has(name)) {
      warned.add(name);
      createLogger().error('ratelimit.binding_missing', { code: 'RATE_LIMIT_UNAVAILABLE', name });
    }
    throw new UnavailableError('Try again shortly.', 'RATE_LIMIT_UNAVAILABLE');
  }
  const { success } = await limiter.limit({ key });
  return success;
}

export async function enforceRateLimit(
  env: AppEnv,
  name: RateLimitName,
  key: string,
): Promise<void> {
  if (!(await checkRateLimit(env, name, key))) throw new RateLimitedError();
}

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** The network (v4 /24, v6 /64) the request comes from: one IPv6 subscriber must not hold 2^64 buckets. */
export const clientRatePrefix = (c: Context): string => ipRatePrefix(clientIp(c)) ?? 'unknown';

/** Middleware: limits per `keyOf(c)` (default: client network prefix). */
export function rateLimit(
  name: RateLimitName,
  keyOf: (c: Context<AppBindings>) => string = clientRatePrefix,
): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    await enforceRateLimit(c.env, name, `${name}:${keyOf(c)}`);
    await next();
  });
}

const MISS_WINDOW_MS = 60_000;
/** Misses per network prefix per minute before token-probing surfaces stop looking tokens up. */
export const ASSET_MISSES_PER_MINUTE = 300;

/**
 * Middleware for token-probing surfaces. Only 404s are charged, per network prefix (/24, /64), so
 * valid traffic never spends it. Once a prefix passes `threshold` misses in a minute, its requests
 * get 429 before any lookup runs, until the window turns over.
 */
export function gateMisses(threshold: number): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const prefix = clientRatePrefix(c);
    const window = Math.floor(c.var.clock.now() / MISS_WINDOW_MS) * MISS_WINDOW_MS;
    const key = `asset.miss:${prefix}`;
    if ((await readCounter(c.env.DB, key, window)) >= threshold) {
      const retry = Math.ceil((window + MISS_WINDOW_MS - c.var.clock.now()) / 1000);
      throw new RateLimitedError(Math.max(retry, 1));
    }
    await next();
    if (c.res.status === 404) await bump(c.env.DB, key, window);
  });
}
