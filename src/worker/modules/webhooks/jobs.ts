import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { finalizeDisabled, runLane } from './deliver.ts';
import { dispatchDue } from './dispatch.ts';
import { overdueEndpoints } from './repo-delivery-read.ts';
import { purge } from './repo-retention.ts';

const DAY = 86_400_000;
export const SWEEP_LANES = 100;

export async function handleWebhookDeliver(
  job: JobOf<'webhook.deliver'>,
  ctx: ServiceContext,
): Promise<void> {
  await runLane(ctx, job);
}

/** Every minute: disable endpoints the handler missed, then claim lanes with due deliveries. */
export async function sweepWebhooks(ctx: ServiceContext): Promise<void> {
  await finalizeDisabled(ctx, await overdueEndpoints(ctx.env.DB, ctx.clock.now()));
  const enqueued = await dispatchDue(ctx, SWEEP_LANES);
  if (enqueued > 0) ctx.log.info('webhooks.sweep', { enqueued });
}

/** Feed `min(30, eventsDays)` days; delivered rows 7; attempts 30 (test sends 7); secrets 1 day past expiry. */
export async function dailyWebhooks(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const { 'retention.eventsDays': eventsDays } = await getPlatformSettings(ctx);
  const purged = await purge(ctx.env.DB, {
    feedBefore: now - Math.min(30, eventsDays) * DAY,
    deliveredBefore: now - 7 * DAY,
    attemptsBefore: now - 30 * DAY,
    testAttemptsBefore: now - 7 * DAY,
    secretsBefore: now - DAY,
  });
  ctx.log.info('webhooks.retention', { ...purged });
}
