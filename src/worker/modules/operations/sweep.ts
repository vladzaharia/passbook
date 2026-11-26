import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteExpired } from './repo-sweep.ts';

const BATCH = 500;
/** At most 5,000 rows a run, so a backlog drains in days without spending the cron's query budget. */
const MAX_BATCHES = 10;

/** The daily hook: ended rows past `expires_at` go. Active rows never expire. */
export async function sweepOperations(ctx: ServiceContext): Promise<void> {
  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await deleteExpired(ctx.env.DB, ctx.clock.now(), BATCH);
    removed += n;
    if (n < BATCH) break;
  }
  if (removed > 0) ctx.log.info('operations.swept', { removed });
}
