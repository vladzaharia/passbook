import type { ServiceContext } from '../../platform/service-context.ts';
import { finishOutbox, type OutboxRow } from '../delivery/repo.ts';
import { recordPassEvent } from '../events/record.ts';
import { insertCaptured } from './repo.ts';

export interface CaptureInput {
  row: OutboxRow;
  lease: string;
  orgId: string;
  /** The pass the email is about, or the bundle's first pass (the ledger needs one). */
  eventPassId: string;
  passId?: string;
  bundleId?: string;
  to: string;
  email: { subject: string; html: string; text: string };
  attached?: boolean;
}

/**
 * Test-mode mail ends here instead of the mailer: the rendered message is kept for the Test
 * inbox and the outbox row ends `sent` with `TEST_MODE`, so nothing retries and nothing counts as
 * a failure. Never calls the mailer.
 */
export async function captureEmail(ctx: ServiceContext, input: CaptureInput): Promise<void> {
  const { row, email } = input;
  await insertCaptured(ctx.env.DB, {
    id: ctx.ids.id(),
    org_id: input.orgId,
    pass_id: input.passId ?? null,
    bundle_id: input.bundleId ?? null,
    outbox_id: row.id,
    recipient: input.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attached: input.attached ?? false,
    created_at: ctx.clock.now(),
  });
  await finishOutbox(
    ctx.env.DB,
    row.id,
    input.lease,
    'sent',
    ctx.clock.now(),
    'TEST_MODE',
    `captured:${row.id}`,
  );
  await recordPassEvent(ctx, {
    orgId: input.orgId,
    passId: input.eventPassId,
    mode: 'test',
    kind: 'email.captured',
    data: input.bundleId
      ? { outboxId: row.id, bundleId: input.bundleId }
      : { outboxId: row.id, attached: input.attached ?? false },
  });
}
