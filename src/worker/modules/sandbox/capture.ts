import { rowIs } from '../../platform/authority-checks.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { BundleEmailIntentSchema } from '../bundles/email-binding.ts';
import { bundleChecks } from '../bundles/repo-delivery-fence.ts';
import { PassEmailIntentSchema } from '../delivery/binding.ts';
import { hasDeliveryLease } from '../delivery/repo-binding.ts';
import { passEmailOutput } from '../delivery/repo-issuance-intent-fence.ts';
import type { OutboxRow } from '../delivery/repo-outbox-map.ts';
import { finishOutbox } from '../delivery/repo-outbox-processing.ts';
import { recordPassEvent } from '../events/record.ts';
import { type CaptureSnapshot, resolveCaptureSnapshot } from './binding.ts';
import { insertCaptured } from './repo-capture.ts';

/** The actor captured at queue time and the lineage checks the capture must still hold. */
/** Cancel only a still-valid lease; an expired or replaced one belongs to the sweeper. */
async function cancelLeased(ctx: ServiceContext, row: OutboxRow, lease: string, code: string) {
  const now = ctx.clock.now();
  if (await hasDeliveryLease(ctx.env.DB, row.id, lease, now))
    await finishOutbox(ctx.env.DB, row.id, lease, 'cancelled', now, code);
}

async function captureOutput(db: D1Database, row: OutboxRow, snapshot: CaptureSnapshot) {
  if (snapshot.kind === 'pass') {
    const intent = PassEmailIntentSchema.safeParse(row.payload.intent);
    return intent.success ? passEmailOutput(db, row.id, intent.data, intent.data.pass) : null;
  }
  const intent = BundleEmailIntentSchema.safeParse(row.payload.intent);
  const first = snapshot.snapshot.passes[0];
  if (!intent.success || !first) return null;
  return {
    actor: intent.data.actor ?? { kind: 'system' as const },
    checks: [
      rowIs('passes', first.id, { deleted_at: null, test_data_quarantined: 0 }),
      ...bundleChecks(snapshot.snapshot),
    ],
  };
}

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
export async function captureEmail(ctx: ServiceContext, input: CaptureInput): Promise<boolean> {
  const { row, email } = input;
  const intent = JSON.stringify(row.payload.intent);
  const ref = {
    org_id: input.orgId,
    pass_id: input.passId ?? null,
    bundle_id: input.bundleId ?? null,
    recipient: input.to,
    attached: input.attached ? 1 : 0,
    intent: intent ?? null,
  };
  const snapshot = await resolveCaptureSnapshot(ctx.env.DB, ref);
  const matchesOutbox =
    row.kind === 'email' &&
    row.orgId === input.orgId &&
    row.payload.to === input.to &&
    (input.bundleId
      ? row.payload.bundleId === input.bundleId && !input.passId && !input.attached
      : row.payload.attach === Boolean(input.attached) && !row.payload.bundleId) &&
    snapshot !== null &&
    row.passId ===
      (snapshot.kind === 'pass' ? snapshot.pass.id : snapshot.snapshot.passes[0]?.id) &&
    input.eventPassId === row.passId;
  const output =
    matchesOutbox && snapshot && intent ? await captureOutput(ctx.env.DB, row, snapshot) : null;
  if (!output || !snapshot || !intent) {
    await cancelLeased(ctx, row, input.lease, 'DELIVERY_STALE');
    return false;
  }
  if ('legacy' in output && output.legacy)
    ctx.log.info('delivery.legacy_intent', { code: 'DELIVERY_LEGACY_INTENT', outboxId: row.id });
  const result = await insertCaptured(
    ctx,
    {
      id: ctx.ids.id(),
      ...ref,
      intent,
      outbox_id: row.id,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attached: input.attached ?? false,
      created_at: ctx.clock.now(),
    },
    input.lease,
    output,
    'test',
    JSON.stringify(row.payload),
  );
  if (result !== 'captured') {
    await cancelLeased(ctx, row, input.lease, result);
    return false;
  }
  await recordPassEvent(ctx, {
    orgId: input.orgId,
    passId: input.eventPassId,
    mode: 'test',
    kind: 'email.captured',
    data: input.bundleId
      ? { outboxId: row.id, bundleId: input.bundleId }
      : { outboxId: row.id, attached: input.attached ?? false },
  });
  return true;
}
