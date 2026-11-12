import { strictEmail } from '../../../shared/email.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { queueEmail } from '../delivery/service.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { Actor } from '../passes/service.ts';
import { bindBundle, bundleEmailSnapshot } from './email-binding.ts';
import { bundleEmailAuditEntry } from './repo-audit.ts';

export const RECIPIENT_NOT_HOLDER = 'Only the holder email of every pass can be used.';

/**
 * Queues the bundle email through the outbox. The row hangs on the bundle's first pass (the outbox
 * is keyed by pass); `payload.bundleId` routes it to the bundle template. Shares the pass email's
 * recipient and org caps. Test-mode bundles queue like any other and are captured, not sent (sandbox/capture.ts).
 */
export async function enqueueBundleEmail(
  ctx: ServiceContext,
  bundleId: string,
  address: string,
  expected: { token: string; holderEmail: string | null },
  authority?: TenantPassWrite,
  audit?: Actor,
  options: { holdersOnly?: boolean } = {},
): Promise<{ outboxId: string }> {
  const to = strictEmail(address);
  if (!to) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  const snapshot = await bundleEmailSnapshot(ctx.env.DB, bundleId);
  const first = snapshot?.passes[0];
  if (!snapshot || !first) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  const { bundle } = snapshot;
  if (bundle.token !== expected.token || bundle.holder_email !== expected.holderEmail)
    throw new ConflictError(
      'The bundle changed. Review the recipient and try again.',
      'DELIVERY_STALE',
    );
  // Not a mail relay for keys: the members' holder emails are pinned again when it sends.
  if (options.holdersOnly && snapshot.passes.some((p) => p.holderEmail !== to))
    throw new ValidationError(RECIPIENT_NOT_HOLDER, [], 'RECIPIENT_NOT_HOLDER');
  const intent = await bindBundle(snapshot, to);
  return queueEmail(ctx, {
    orgId: bundle.org_id,
    passId: first.id,
    mode: bundle.mode,
    to,
    payload: { to, bundleId, intent },
    event: { bundleId },
    bundleSnapshot: snapshot,
    ...(authority ? { authority } : {}),
    ...(audit ? { auditEntry: bundleEmailAuditEntry(bundle.org_id, bundleId, audit) } : {}),
  });
}
