import type { ServiceContext } from '../../platform/service-context.ts';
import { LOG_BODY_MS, LOG_META_MS, purgeBodies, purgeRows } from './repo-request-log.ts';

const SLICE = 500;
/** One run works this long at most; the next minute carries on, so a backlog is caught up and never skipped. */
export const PURGE_BUDGET_MS = 20_000;

/** Runs `step` until a slice comes back short (caught up) or the time is spent. */
async function drain(step: (limit: number) => Promise<number>, until: number): Promise<number> {
  let total = 0;
  while (Date.now() < until) {
    const n = await step(SLICE);
    total += n;
    if (n < SLICE) break;
  }
  return total;
}

/** Blanks bodies older than 24 hours and deletes rows older than 7 days. Reads already hide both; this frees the storage. */
export async function purgeRequestLog(
  ctx: ServiceContext,
  budgetMs = PURGE_BUDGET_MS,
): Promise<{ bodies: number; rows: number }> {
  const now = ctx.clock.now();
  const until = Date.now() + budgetMs;
  const bodies = await drain((n) => purgeBodies(ctx.env.DB, now - LOG_BODY_MS, n), until);
  const rows = await drain((n) => purgeRows(ctx.env.DB, now - LOG_META_MS, n), until);
  if (bodies + rows > 0) ctx.log.info('developer.request_log_purged', { bodies, rows });
  return { bodies, rows };
}

/** Minute hook `developer.request_log_purge`: two indexed probes when nothing is due, a time-boxed drain when it is. */
export const minutelyRequestLogPurge = async (ctx: ServiceContext): Promise<void> => {
  await purgeRequestLog(ctx);
};
