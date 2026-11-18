import type { IssuanceOutcome } from '../../../shared/copy/email.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { limitReached } from './email-limits.ts';
import { getIntent } from './repo-issuance-recovery.ts';

/** What became of a pass's issuance email, read from its durable intent. */
export async function issuanceEmailOutcome(
  ctx: ServiceContext,
  passId: string,
): Promise<{ outcome: IssuanceOutcome; cap?: 'org' | 'recipient' }> {
  const row = await getIntent(ctx.env.DB, passId);
  if (!row) return { outcome: 'none' };
  if (row.state === 'queued') return { outcome: 'queued' };
  if (row.state === 'cancelled') return { outcome: 'cancelled' };
  const cap = await limitReached(ctx, row.mode, row.org_id, row.recipient);
  return cap ? { outcome: `limited_${cap}`, cap } : { outcome: 'deferred' };
}
