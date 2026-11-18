import type { JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { retentionTargets } from '../retention/targets.ts';
import { finalizeDisabled, runLane } from './deliver.ts';
import { dispatchDue } from './dispatch.ts';
import { daysOf, PURGE_LIMITS, purgeScope } from './purge-run.ts';
import { overdueEndpoints } from './repo-delivery-read.ts';
import { type PurgeKind, purgeSecrets } from './repo-retention.ts';

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
 * Daily, under the `webhooks` and `events` retention plans (`daysOf`). Every chunk commits with its receipt,
 * with the days that drove it. A held org or pass keeps its rows. Secrets go 1 day past expiry. Work per run is
 * bounded (`PURGE_LIMITS`); the rest waits for the next run.
 */
export async function dailyWebhooks(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const targets = await retentionTargets(ctx, ['webhooks', 'events']);
  const total = { feed: 0, delivered: 0, attempts: 0, testAttempts: 0 };
  const add = (n: Record<PurgeKind, number>) => {
    for (const k of Object.keys(total) as PurgeKind[]) total[k] += n[k];
  };
  if (targets) {
    add(
      await purgeScope(
        ctx,
        null,
        { kind: 'platform', exclude: targets.exclude },
        daysOf(targets.platform),
        { chunks: PURGE_LIMITS.platformChunks },
      ),
    );
    const budget = { chunks: PURGE_LIMITS.orgChunks };
    let visited = 0;
    for (const o of targets.orgs) {
      if (budget.chunks <= 0) break;
      try {
        add(
          await purgeScope(ctx, o.orgId, { kind: 'org', orgId: o.orgId }, daysOf(o.days), budget),
        );
      } catch (error) {
        // One failing org must not stop the rotation: it runs again at its next visit.
        ctx.log.error('webhooks.retention_org_failed', {
          orgId: o.orgId,
          code: 'WEBHOOK_RETENTION',
          error,
        });
      }
      visited++;
    }
    await targets.finish(visited);
  }
  const secrets = await purgeSecrets(ctx.env.DB, now - DAY);
  ctx.log.info('webhooks.retention', { ...total, secrets });
}
