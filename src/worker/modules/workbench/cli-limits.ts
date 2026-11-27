import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Fixed windows in D1 (`counters`): the rate-limit bindings count 60 seconds only. */
export interface Window {
  key: string;
  ms: number;
  limit: number;
}

const START = (prefix: string): Window => ({ key: `cli.start:${prefix}`, ms: HOUR, limit: 10 });
const MISS_ACCOUNT = (userId: string): Window => ({
  key: `cli.miss:u:${userId}`,
  ms: 15 * MINUTE,
  limit: 5,
});
const MISS_PREFIX = (prefix: string): Window => ({
  key: `cli.miss:p:${prefix}`,
  ms: HOUR,
  limit: 20,
});

const startOf = (ctx: ServiceContext, w: Window) => Math.floor(ctx.clock.now() / w.ms) * w.ms;

/** Counts this try first, atomically, so parallel callers cannot all read a count under the limit. */
async function chargeOrRefuse(ctx: ServiceContext, w: Window): Promise<void> {
  const start = startOf(ctx, w);
  if ((await bump(ctx.env.DB, w.key, start)) > w.limit)
    throw new RateLimitedError(Math.max(Math.ceil((start + w.ms - ctx.clock.now()) / 1000), 1));
}

/** 10 sessions an hour per network prefix. Every start is charged, found or not. */
export const chargeStart = (ctx: ServiceContext, prefix: string) =>
  chargeOrRefuse(ctx, START(prefix));

/**
 * Every lookup counts as a try before it runs: past 5 per account in 15 minutes or 20 per network prefix in an
 * hour, 429. `refundLookup` gives a found code's try back, so only misses stay counted.
 */
export async function chargeLookup(
  ctx: ServiceContext,
  userId: string,
  prefix: string,
): Promise<void> {
  await chargeOrRefuse(ctx, MISS_ACCOUNT(userId));
  await chargeOrRefuse(ctx, MISS_PREFIX(prefix));
}

export async function refundLookup(ctx: ServiceContext, userId: string, prefix: string) {
  await Promise.all(
    [MISS_ACCOUNT(userId), MISS_PREFIX(prefix)].map((w) =>
      bump(ctx.env.DB, w.key, startOf(ctx, w), -1),
    ),
  );
}
