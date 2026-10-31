import type { Job, JobOf } from '../../jobs/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { deliverEmail } from './email.ts';
import { deliverPush } from './push.ts';
import { deleteFinishedOutbox, failOutbox, reclaimStaleLeases } from './repo.ts';
import { dispatchOutbox, redispatchLost } from './service.ts';

const DAY = 86_400_000;
const LOST_ENQUEUE_GRACE_MS = 10 * 60_000;

export async function handlePushDeliver(
  job: JobOf<'push.deliver'>,
  ctx: ServiceContext,
): Promise<void> {
  await deliverPush(ctx, job.outboxId);
}

export async function handleEmailSend(
  job: JobOf<'email.send'>,
  ctx: ServiceContext,
): Promise<void> {
  await deliverEmail(ctx, job.outboxId);
}

/** Every minute: expire stale leases, re-send lost enqueues, dispatch what is due. */
export async function sweepDelivery(ctx: ServiceContext): Promise<void> {
  const stale = await reclaimStaleLeases(ctx.env.DB, ctx.clock.now());
  const lost = await redispatchLost(ctx, LOST_ENQUEUE_GRACE_MS);
  const dispatched = await dispatchOutbox(ctx);
  if (stale.retried || stale.failed || lost || dispatched)
    ctx.log.info('delivery.sweep', { ...stale, lost, dispatched });
}

/** Outbox: sent and cancelled 30 days, failed and partial 90 days. push_results cascade. */
export async function dailyDelivery(ctx: ServiceContext): Promise<void> {
  const now = ctx.clock.now();
  const removed = await deleteFinishedOutbox(ctx.env.DB, now - 30 * DAY, now - 90 * DAY);
  ctx.log.info('delivery.retention', { removed });
}

/** Finalizes a job that exhausted its retries: mark the outbox row failed and write an audit event. */
export async function handleDeadLetter(job: Job, ctx: ServiceContext): Promise<void> {
  if (job.kind !== 'push.deliver' && job.kind !== 'email.send') {
    ctx.log.error('queue.dead_letter', { job: job.kind, code: 'DEAD_LETTER' });
    return;
  }
  const row = await failOutbox(ctx.env.DB, job.outboxId, ctx.clock.now(), 'DEAD_LETTER');
  if (!row) return;
  ctx.log.error('delivery.dead_letter', { outboxId: row.id, kind: row.kind, code: 'DEAD_LETTER' });
  await recordAudit(ctx, {
    orgId: row.orgId,
    actorType: 'system',
    action: 'delivery.dead_letter',
    targetType: 'pass',
    targetId: row.passId,
    detail: { outboxId: row.id, kind: row.kind, attempts: row.attempts },
  });
}
