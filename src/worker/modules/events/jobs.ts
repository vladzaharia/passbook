import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { recordCronRun } from '../status/cron.ts';
import { deleteEventsBefore } from './repo.ts';

const DAY_MS = 86_400_000;
const BATCH = 1000;
const MAX_BATCHES = 50;

/** Deletes events older than retention.eventsDays, in bounded batches. */
export async function dailyEvents(ctx: ServiceContext): Promise<void> {
  const { 'retention.eventsDays': days } = await getPlatformSettings(ctx);
  const cutoff = ctx.clock.now() - days * DAY_MS;
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await deleteEventsBefore(ctx.env.DB, cutoff, BATCH);
    deleted += n;
    if (n < BATCH) break;
  }
  ctx.log.info('events.retention', { deleted, days });
  await recordCronRun(ctx, 'daily');
}
