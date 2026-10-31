import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { recordCronRun } from '../status/cron.ts';
import { deleteAuditBefore } from './repo.ts';

const DAY_MS = 86_400_000;
const BATCH = 1000;
const MAX_BATCHES = 50;

/** Deletes audit rows older than retention.auditDays, in bounded batches. */
export async function dailyAudit(ctx: ServiceContext): Promise<void> {
  const { 'retention.auditDays': days } = await getPlatformSettings(ctx);
  const cutoff = ctx.clock.now() - days * DAY_MS;
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await deleteAuditBefore(ctx.env.DB, cutoff, BATCH);
    deleted += n;
    if (n < BATCH) break;
  }
  ctx.log.info('audit.retention', { deleted, days });
  await recordCronRun(ctx, 'daily');
}
