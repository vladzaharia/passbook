import { strictEmail } from '../../../shared/email.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { queueEmail } from '../delivery/service.ts';
import { getBundle, membersOf } from './repo.ts';

/**
 * Queues the bundle email through the outbox. The row hangs on the bundle's first pass (the outbox
 * is keyed by pass); `payload.bundleId` routes it to the bundle template. Shares the pass email's
 * recipient and org caps. Test-mode bundles queue like any other and end `cancelled/TEST_MODE`.
 */
export async function enqueueBundleEmail(
  ctx: ServiceContext,
  bundleId: string,
  address: string,
): Promise<{ outboxId: string }> {
  const to = strictEmail(address);
  if (!to) throw new ValidationError('Enter a valid email address.', [], 'EMAIL_INVALID');
  const bundle = await getBundle(ctx.env.DB, bundleId, null);
  const first = bundle ? (await membersOf(ctx.env.DB, [bundleId]))[0] : undefined;
  if (!bundle || !first) throw new NotFoundError('Bundle not found.', 'BUNDLE_NOT_FOUND');
  return queueEmail(ctx, {
    orgId: bundle.org_id,
    passId: first.pass_id,
    to,
    payload: { to, bundleId },
  });
}
