import { strictEmail } from '../../../shared/email.ts';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { bumpCounter, insertOutbox } from '../delivery/repo.ts';
import {
  dispatchSafely,
  EMAIL_ORG_DAILY_CAP,
  EMAIL_RECIPIENT_HOURLY_CAP,
} from '../delivery/service.ts';
import { getBundle, membersOf } from './repo.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  const now = ctx.clock.now();
  const recipient = (await sha256Hex(`pass-email:${to.toLowerCase()}`)).slice(0, 32);
  const perRecipient = await bumpCounter(
    ctx.env.DB,
    `pass-email:to:${recipient}`,
    now - (now % HOUR),
  );
  const perOrg = await bumpCounter(
    ctx.env.DB,
    `pass-email:org:${bundle.org_id}`,
    now - (now % DAY),
  );
  if (perRecipient > EMAIL_RECIPIENT_HOURLY_CAP || perOrg > EMAIL_ORG_DAILY_CAP)
    throw new AppError('EMAIL_RATE_LIMITED', 429, 'Too many pass emails. Try again later.', {
      headers: { 'retry-after': '3600' },
    });
  const outboxId = ctx.ids.id();
  await insertOutbox(ctx.env.DB, {
    id: outboxId,
    orgId: bundle.org_id,
    kind: 'email',
    passId: first.pass_id,
    coalesceKey: null,
    payload: { to, bundleId },
    now,
  });
  ctx.waitUntil(dispatchSafely(ctx, { passId: first.pass_id }));
  return { outboxId };
}
