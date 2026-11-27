import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

const REISSUES_PER_KEY_HOUR = 6;
const REISSUES_PER_ORG_HOUR = 12;
const HOUR_MS = 60 * 60_000;

/** Like the Apple twin (passes/routes-bulk.ts): a key starts six an hour, and an org twelve whoever asks. */
export async function limitReissues(ctx: ServiceContext, keyId: string | null, orgId: string) {
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR_MS) * HOUR_MS;
  const retry = Math.ceil((window + HOUR_MS - now) / 1000);
  if (
    keyId &&
    (await bump(ctx.env.DB, `wallet-reissue:key:${keyId}`, window)) > REISSUES_PER_KEY_HOUR
  )
    throw new RateLimitedError(retry);
  if ((await bump(ctx.env.DB, `wallet-reissue:org:${orgId}`, window)) > REISSUES_PER_ORG_HOUR)
    throw new RateLimitedError(retry);
}
