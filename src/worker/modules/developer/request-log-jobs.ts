import type { ServiceContext } from '../../platform/service-context.ts';
import { LOG_BODY_MS, LOG_META_MS, purgeBodies, purgeRows } from './repo-request-log.ts';

const SLICE = 500;
const MAX_SLICES = 20;
/** Runs when the clock reads this minute of the hour: the minute cron calls the hook, the purge is hourly. */
const PURGE_MINUTE = 7;

async function drain(step: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_SLICES; i++) {
    const n = await step(SLICE);
    total += n;
    if (n < SLICE) break;
  }
  return total;
}

/** Blanks bodies older than 24 hours and deletes rows older than 7 days. Reads already hide both; this frees the storage. */
export async function purgeRequestLog(
  ctx: ServiceContext,
): Promise<{ bodies: number; rows: number }> {
  const now = ctx.clock.now();
  const bodies = await drain((n) => purgeBodies(ctx.env.DB, now - LOG_BODY_MS, n));
  const rows = await drain((n) => purgeRows(ctx.env.DB, now - LOG_META_MS, n));
  if (bodies + rows > 0) ctx.log.info('developer.request_log_purged', { bodies, rows });
  return { bodies, rows };
}

/** Minute hook `developer.request_log_purge`: the purge, once an hour. */
export async function hourlyRequestLogPurge(ctx: ServiceContext): Promise<void> {
  if (new Date(ctx.clock.now()).getUTCMinutes() !== PURGE_MINUTE) return;
  await purgeRequestLog(ctx);
}
