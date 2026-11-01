import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import type { AppEnv, RateLimitName } from './env.ts';
import { RateLimitedError, UnavailableError } from './errors.ts';
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

/** Middleware: limits per `keyOf(c)` (default: client IP). */
export function rateLimit(
  name: RateLimitName,
  keyOf: (c: Context<AppBindings>) => string = clientIp,
): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    await enforceRateLimit(c.env, name, `${name}:${keyOf(c)}`);
    await next();
  });
}
