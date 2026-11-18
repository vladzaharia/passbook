import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { writeReceipt } from '../retention/receipt-service.ts';
import type { Scope } from '../retention/repo-sweep.ts';
import { retentionTargets } from '../retention/targets.ts';
import { finalizeDisabled, runLane } from './deliver.ts';
import { dispatchDue } from './dispatch.ts';
import { overdueEndpoints } from './repo-delivery-read.ts';
import { purge, purgeSecrets } from './repo-retention.ts';

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

/**
 * Daily, under the `webhooks` and `events` retention plans: the feed keeps `min(webhooksDays, eventsDays)`,
 * delivered rows `min(7, webhooksDays)`, attempts `webhooksDays` (test sends `min(7, webhooksDays)`). Secrets go
 * 1 day past expiry. A held org or pass keeps its rows.
 */
export async function dailyWebhooks(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const targets = await retentionTargets(ctx, ['webhooks', 'events']);
  const total = { feed: 0, delivered: 0, attempts: 0, testAttempts: 0 };
  const run = async (
    orgId: string | null,
    days: { webhooks: number; events: number },
    scope: Scope,
  ) => {
    const feedDays = Math.min(days.webhooks, days.events);
    const purged = await purge(
      ctx.env.DB,
      {
        feedBefore: now - feedDays * DAY,
        deliveredBefore: now - Math.min(7, days.webhooks) * DAY,
        attemptsBefore: now - days.webhooks * DAY,
        testAttemptsBefore: now - Math.min(7, days.webhooks) * DAY,
      },
      scope,
    );
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += purged[k];
    const deleted = purged.feed + purged.delivered + purged.attempts + purged.testAttempts;
    if (deleted > 0)
      await writeReceipt(ctx, {
        orgId,
        cls: 'webhooks',
        kind: 'sweep',
        policyDays: days.webhooks,
        cutoffAt: now - days.webhooks * DAY,
        deleted,
      });
  };
  if (targets) {
    await run(null, targets.platform, { kind: 'platform', exclude: targets.exclude });
    let visited = 0;
    for (const o of targets.orgs) {
      await run(o.orgId, o.days, { kind: 'org', orgId: o.orgId });
      visited++;
    }
    await targets.finish(visited);
  }
  const secrets = await purgeSecrets(ctx.env.DB, now - DAY);
  ctx.log.info('webhooks.retention', { ...total, secrets });
}
