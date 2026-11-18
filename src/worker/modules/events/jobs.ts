import type { ServiceContext } from '../../platform/service-context.ts';
import { sweepClass } from '../retention/sweep.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { recordCronRun } from '../status/cron.ts';
import { deleteTestEventsBefore } from './repo.ts';

const DAY_MS = 86_400_000;
const BATCH = 1000;
const MAX_BATCHES = 50;

/**
 * Live events follow the retention plan (org values, floors, holds). Test-mode events keep the platform
 * default window, in bounded batches.
 */
export async function dailyEvents(ctx: ServiceContext): Promise<void> {
  const live = await sweepClass(ctx, 'events');
  const { 'retention.eventsDays': days } = await getPlatformSettings(ctx);
  const cutoff = ctx.clock.now() - days * DAY_MS;
  let test = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await deleteTestEventsBefore(ctx.env.DB, cutoff, BATCH);
    test += n;
    if (n < BATCH) break;
  }
  ctx.log.info('events.retention', { live, test, days });
  await recordCronRun(ctx, 'daily');
}
