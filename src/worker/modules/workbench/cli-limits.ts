import { bump, read } from '../../platform/counters.ts';
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

/** 429 once the window holds its limit, with the seconds until it turns over. */
async function refuseIfFull(ctx: ServiceContext, w: Window): Promise<void> {
  const start = startOf(ctx, w);
  if ((await read(ctx.env.DB, w.key, start)) >= w.limit)
    throw new RateLimitedError(Math.max(Math.ceil((start + w.ms - ctx.clock.now()) / 1000), 1));
}

const charge = (ctx: ServiceContext, w: Window) => bump(ctx.env.DB, w.key, startOf(ctx, w));

/** 10 sessions an hour per network prefix. Every start is charged, found or not. */
export async function chargeStart(ctx: ServiceContext, prefix: string): Promise<void> {
  const w = START(prefix);
  await refuseIfFull(ctx, w);
  await charge(ctx, w);
}

/** Before a lookup: locked past 5 misses per account in 15 minutes or 20 per network prefix in an hour. */
export async function assertCodeOpen(
  ctx: ServiceContext,
  userId: string,
  prefix: string,
): Promise<void> {
  await refuseIfFull(ctx, MISS_ACCOUNT(userId));
  await refuseIfFull(ctx, MISS_PREFIX(prefix));
}

/** A miss, an expired code and a used code are all one miss. */
export async function chargeMiss(ctx: ServiceContext, userId: string, prefix: string) {
  await Promise.all([charge(ctx, MISS_ACCOUNT(userId)), charge(ctx, MISS_PREFIX(prefix))]);
}
