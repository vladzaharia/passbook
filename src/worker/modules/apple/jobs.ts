import type { ServiceContext } from '../../platform/service-context.ts';
import { purgeLogs, purgeRevisions } from './repo.ts';

const DAY = 86_400_000;

/** Device logs and revision markers: 7 days. */
export async function dailyApple(ctx: ServiceContext): Promise<void> {
  const before = ctx.clock.now() - 7 * DAY;
  const logs = await purgeLogs(ctx.env.DB, before);
  const revisions = await purgeRevisions(ctx.env.DB, before);
  ctx.log.info('apple.retention', { logs, revisions });
}
