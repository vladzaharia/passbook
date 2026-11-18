import type { IssuanceOutcome } from '../../../shared/copy/email.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { limitReached } from './email-limits.ts';
import { outboxAvailableAt } from './repo-email-queue.ts';
import { getIntent } from './repo-issuance-recovery.ts';

/** What became of a pass's issuance email, read from its durable intent. */
export async function issuanceEmailOutcome(
  ctx: ServiceContext,
  passId: string,
): Promise<{ outcome: IssuanceOutcome; cap?: 'org' | 'recipient' }> {
  const row = await getIntent(ctx.env.DB, passId);
  if (!row) return { outcome: 'none' };
  if (row.state === 'queued') {
    const due = row.outbox_id ? await outboxAvailableAt(ctx.env.DB, row.outbox_id) : 0;
    // Over the platform ceiling the row waits for a later hour: the normal deferred outcome.
    return { outcome: due > ctx.clock.now() ? 'deferred' : 'queued' };
  }
  if (row.state === 'cancelled') return { outcome: 'cancelled' };
  const cap = await limitReached(ctx, row.mode, row.org_id, row.recipient);
  return cap ? { outcome: `limited_${cap}`, cap } : { outcome: 'deferred' };
}
