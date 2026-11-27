import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from './context.ts';
import { bump, read as readCounter } from './counters.ts';
import type { AppEnv, RateLimitName } from './env.ts';
import { RateLimitedError, UnavailableError } from './errors.ts';
import { sha256Hex } from './ids.ts';
import { ipBucket, ipRatePrefix } from './ip.ts';
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

/** Every ratelimits binding in wrangler.jsonc counts per 60-second window. */
const WINDOW_SECONDS = 60;
/** The RL_API_KEY budget per key and window; keep equal to wrangler.jsonc. */
export const API_KEY_LIMIT = 600;

/** Seconds until the current window turns over: the longest a limited caller must wait. */
export const secondsToReset = (nowMs: number): number =>
  WINDOW_SECONDS - (Math.floor(nowMs / 1000) % WINDOW_SECONDS);

/** `RateLimit-Policy: 600;w=60`, with the limit and reset; sent on every API-key response. */
function policyHeaders(limit: number, nowMs: number): Record<string, string> {
  return {
    'ratelimit-policy': `${limit};w=${WINDOW_SECONDS}`,
    'ratelimit-limit': String(limit),
    'ratelimit-reset': String(secondsToReset(nowMs)),
  };
}

export async function enforceRateLimit(
  env: AppEnv,
  name: RateLimitName,
  key: string,
): Promise<void> {
  if (await checkRateLimit(env, name, key)) return;
  // Only a key's own budget (`key:<id>`) has a published policy; RL_API_KEY also guards other callers.
  if (name !== 'RL_API_KEY' || !key.startsWith('key:')) throw new RateLimitedError();
  // The limiter's windows are not promised to align with the clock: the wait is at least this long.
  const now = Date.now();
  throw new RateLimitedError(Math.max(secondsToReset(now), 1), undefined, {
    ...policyHeaders(API_KEY_LIMIT, now),
    'ratelimit-remaining': '0',
  });
}

/** Writes a Platform key makes on platform routes per window, on top of its tier; keep equal to wrangler.jsonc. */
export const PLATFORM_WRITE_LIMIT = 60;

/** Charges a Platform key's write budget (429 RATE_LIMITED past it). Reads are not charged. */
export async function chargePlatformWrite(env: AppEnv, keyId: string): Promise<void> {
  if (await checkRateLimit(env, 'RL_PLATFORM_WRITE', `key:${keyId}`)) return;
  const now = Date.now();
  throw new RateLimitedError(Math.max(secondsToReset(now), 1), undefined, {
    ...policyHeaders(PLATFORM_WRITE_LIMIT, now),
    'ratelimit-remaining': '0',
  });
}

export type ApiRateTier = 'standard' | 'high' | 'bulk';

/** Per-key budget per tier; keep equal to the wrangler.jsonc bindings. */
const TIERS: Record<ApiRateTier, { name: RateLimitName; limit: number }> = {
  standard: { name: 'RL_API_KEY', limit: API_KEY_LIMIT },
  high: { name: 'RL_API_KEY_HIGH', limit: 3000 },
  bulk: { name: 'RL_API_KEY_BULK', limit: 12000 },
};
/** Calls a minute a key of `tier` may make. */
export const tierLimit = (tier: ApiRateTier): number => TIERS[tier].limit;
/** The RL_API_ORG budget across all of one org's keys; keep equal to wrangler.jsonc. */
export const API_ORG_LIMIT = 6000;

const isTier = (v: unknown): v is ApiRateTier => typeof v === 'string' && v in TIERS;

/** The key's stored tier, else `API_RATE_TIER_DEFAULT`, else standard. */
export const apiRateTier = (stored: unknown, env: AppEnv): ApiRateTier =>
  isTier(stored)
    ? stored
    : isTier(env.API_RATE_TIER_DEFAULT)
      ? env.API_RATE_TIER_DEFAULT
      : 'standard';

/** Tier and org of each resolved key, for the response headers; keyed by the auth object. */
const keyBudgets = new WeakMap<object, { tier: ApiRateTier }>();
export const rememberApiTier = (auth: object, tier: ApiRateTier): void => {
  keyBudgets.set(auth, { tier });
};

/**
 * Charges a key's own budget, then its org's aggregate (so a key over its own limit does not spend
 * the org's). Throws 429 with the policy that refused. Returns the key's tier.
 */
export async function enforceApiKeyRate(
  env: AppEnv,
  key: { keyId: string; orgId: string | null },
  stored: unknown,
): Promise<ApiRateTier> {
  const tier = apiRateTier(stored, env);
  const budgets = [
    { name: TIERS[tier].name, id: `key:${key.keyId}`, limit: TIERS[tier].limit, who: 'key' },
    ...(key.orgId
      ? [{ name: 'RL_API_ORG' as const, id: `org:${key.orgId}`, limit: API_ORG_LIMIT, who: 'org' }]
      : []),
  ];
  for (const b of budgets) {
    if (await checkRateLimit(env, b.name, b.id)) continue;
    const now = Date.now();
    throw new RateLimitedError(
      Math.max(secondsToReset(now), 1),
      b.who === 'org'
        ? 'Your organization is over its API rate limit. Try again later.'
        : undefined,
      { ...policyHeaders(b.limit, now), 'ratelimit-remaining': '0' },
    );
  }
  return tier;
}

/** Middleware: tells an API-key caller its budget. The limiter reports pass or fail only, so `RateLimit-Remaining` is sent on 429 alone. */
export const apiKeyRateHeaders: MiddlewareHandler<AppBindings> = createMiddleware(
  async (c, next) => {
    await next();
    if (c.var.auth?.kind !== 'api_key' || c.res.headers.has('ratelimit-policy')) return;
    const tier = keyBudgets.get(c.var.auth)?.tier ?? 'standard';
    for (const [name, value] of Object.entries(policyHeaders(TIERS[tier].limit, Date.now())))
      c.header(name, value);
  },
);

export function clientIp(c: Context): string {
  return c.req.header('cf-connecting-ip') ?? 'unknown';
}

/** A bearer token as a limiter key: a truncated digest, so the token itself is never a key. */
export async function tokenBucket(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 32);
}

/** The asset limiter's key: the token (as a digest) and the network prefix; a malformed token shares its prefix's bucket. */
export async function assetBucket(
  c: Context,
  isTokenShape: (token: string) => boolean,
): Promise<string> {
  const prefix = ipRatePrefix(clientIp(c)) ?? 'unknown';
  const token = c.req.param('token') ?? '';
  return isTokenShape(token) ? `${await tokenBucket(token)}:${prefix}` : `prefix:${prefix}`;
}

/** The default key: the IPv4 address or IPv6 /64, so one subscriber does not hold 2^64 buckets. */
export const clientBucket = (c: Context): string => ipBucket(clientIp(c)) ?? 'unknown';

/** The network (v4 /24, v6 /64) of the request: the key of login and guessing limits. */
export const clientRatePrefix = (c: Context): string => ipRatePrefix(clientIp(c)) ?? 'unknown';

/** Middleware: limits per `keyOf(c)` (default: client IP bucket). */
export function rateLimit(
  name: RateLimitName,
  keyOf: (c: Context<AppBindings>) => string | Promise<string> = clientBucket,
): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    await enforceRateLimit(c.env, name, `${name}:${await keyOf(c)}`);
    await next();
  });
}

const MISS_WINDOW_MS = 60_000;
/** Misses per network prefix per minute before token-probing surfaces stop looking tokens up. */
export const ASSET_MISSES_PER_MINUTE = 300;

/**
 * Middleware for token-probing surfaces. Only responses with `status` (404 by default) are charged, per network prefix (/24, /64), so
 * valid traffic never spends it. Once a prefix passes `threshold` misses in a minute, its requests
 * get 429 before any lookup runs, until the window turns over.
 */
export function gateMisses(
  threshold: number,
  { status = 404, name = 'asset.miss' }: { status?: number; name?: string } = {},
): MiddlewareHandler<AppBindings> {
  return createMiddleware(async (c, next) => {
    const prefix = clientRatePrefix(c);
    const window = Math.floor(c.var.clock.now() / MISS_WINDOW_MS) * MISS_WINDOW_MS;
    const key = `${name}:${prefix}`;
    if ((await readCounter(c.env.DB, key, window)) >= threshold) {
      const retry = Math.ceil((window + MISS_WINDOW_MS - c.var.clock.now()) / 1000);
      throw new RateLimitedError(Math.max(retry, 1));
    }
    await next();
    if (c.res.status === status) await bump(c.env.DB, key, window);
  });
}
