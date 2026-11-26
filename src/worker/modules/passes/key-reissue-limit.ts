import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

const REISSUES_PER_KEY_HOUR = 6;
const HOUR_MS = 60 * 60_000;

/** A key starts at most six rebuilds an hour: each one rebuilds and pushes a whole template. */
export async function limitKeyReissues(ctx: ServiceContext, keyId: string): Promise<void> {
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR_MS) * HOUR_MS;
  if ((await bump(ctx.env.DB, `bulk-reissue:key:${keyId}`, window)) > REISSUES_PER_KEY_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR_MS - now) / 1000));
}
