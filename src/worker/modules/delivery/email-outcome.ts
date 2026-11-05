import { writeEvent } from '../../platform/analytics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvent } from '../events/record.ts';
import { retryOrGiveUp } from './push.ts';
import { finishOutbox, type OutboxRow } from './repo.ts';

/** A failure that retrying cannot fix. */
export class PermanentEmailError extends Error {}

/** What the Sync log and metrics need about a sent or failed email. */
export interface EmailTarget {
  orgId: string;
  /** The pass the ledger row hangs on (a bundle's first pass for bundle emails). */
  passId: string;
  mode: 'live' | 'test';
  templateId: string | null;
  identityId: string | null;
  attached?: boolean;
  bundleId?: string;
}

export async function recordEmailOutcome(
  ctx: ServiceContext,
  row: OutboxRow,
  target: EmailTarget,
  outcome: 'ok' | 'failed',
  code?: string,
): Promise<void> {
  writeEvent(ctx.env, {
    event: 'email.result',
    orgId: target.orgId,
    templateId: target.templateId,
    identityId: target.identityId,
    outcome,
    mode: target.mode,
  });
  await recordPassEvent(ctx, {
    orgId: target.orgId,
    passId: target.passId,
    mode: target.mode,
    kind: outcome === 'ok' ? 'email.sent' : 'email.failed',
    data: {
      outboxId: row.id,
      ...(target.bundleId ? { bundleId: target.bundleId } : { attached: target.attached ?? false }),
      ...(code ? { code } : {}),
    },
  });
}

/** Records the failure, then ends the row (permanent) or schedules a retry. */
export async function failEmail(
  ctx: ServiceContext,
  claimed: { row: OutboxRow; lease: string },
  target: EmailTarget,
  error: unknown,
): Promise<void> {
  const { row, lease } = claimed;
  const permanent = error instanceof PermanentEmailError;
  await recordEmailOutcome(
    ctx,
    row,
    target,
    'failed',
    permanent ? 'EMAIL_PERMANENT' : 'EMAIL_FAILED',
  );
  if (permanent) {
    ctx.log.warn('email.send_failed', { outboxId: row.id, code: 'EMAIL_PERMANENT', error });
    await finishOutbox(ctx.env.DB, row.id, lease, 'failed', ctx.clock.now(), 'EMAIL_PERMANENT');
    return;
  }
  ctx.log.warn('email.send_failed', { outboxId: row.id, attempts: row.attempts, error });
  await retryOrGiveUp(ctx, row, lease, 'EMAIL_FAILED', 'failed');
}
