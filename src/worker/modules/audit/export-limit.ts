import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

const HOUR = 3_600_000;
const EXPORTS_PER_HOUR = 6;

/**
 * An export reads up to 10,000 entries, so each user and each organization gets a few an hour (fixed window).
 * The 429 says how long to wait. Counters are D1 rows, so the budget holds across isolates.
 */
export async function enforceExportLimit(
  ctx: ServiceContext,
  keys: readonly string[],
): Promise<void> {
  const now = ctx.clock.now();
  const start = Math.floor(now / HOUR) * HOUR;
  for (const key of keys) {
    if ((await bump(ctx.env.DB, `audit.export:${key}`, start)) > EXPORTS_PER_HOUR) {
      const minutes = Math.max(1, Math.ceil((start + HOUR - now) / 60_000));
      throw new RateLimitedError(
        Math.ceil((start + HOUR - now) / 1000),
        `Export limit reached. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
      );
    }
  }
}
