import type { ServiceContext } from '../../platform/service-context.ts';
import { deleteExpired } from './repo-sweep.ts';

const BATCH = 500;

/** The daily hook: ended rows past `expires_at` go. Active rows never expire. */
export async function sweepOperations(ctx: ServiceContext): Promise<void> {
  const removed = await deleteExpired(ctx.env.DB, ctx.clock.now(), BATCH);
  if (removed > 0) ctx.log.info('operations.swept', { removed });
}
