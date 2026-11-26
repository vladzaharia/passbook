import { all } from '../../platform/db.ts';
import type { MoveRow } from './repo-identity-move.ts';

/**
 * The provider's latest report on a pass is a save. Neither provider proves a holder's installation, so the
 * reports (`wallet.saved`, `wallet.removed`) are the only evidence a device holds a copy; a later removal clears it.
 */
const savedOn = (pass: string, provider: string) =>
  `COALESCE((SELECT e.kind = 'wallet.saved' FROM pass_events e WHERE e.pass_id = ${pass}
    AND e.kind IN ('wallet.saved', 'wallet.removed') AND json_extract(e.data, '$.provider') = ${provider}
    ORDER BY e.at DESC, e.id DESC LIMIT 1), 0)`;

/**
 * The providers whose copy of the old pass is saved and live while the replacement's is not: voiding the old
 * pass would take away what a device holds. A copy nobody saved is voided with the pass, by the provider's own
 * void path (the pass write marks it dirty in the same batch).
 */
const heldFrom = (old: string, next: string) =>
  `FROM wallet_provider_instances w WHERE w.pass_id = ${old} AND w.lifecycle = 'active'
    AND ${savedOn('w.pass_id', 'w.provider')} AND NOT ${savedOn(next, 'w.provider')}`;

/** For `claimVoid`, which reads the row it updates. */
export const HELD_COPY = `EXISTS (SELECT 1 ${heldFrom('pass_moves.old_pass_id', 'pass_moves.new_pass_id')})`;

/** `wallet_copy:google`, `wallet_copy:samsung` or `wallet_copy:google+samsung`: the row's reason; null when none is held. */
export async function heldReason(
  db: D1Database,
  row: Pick<MoveRow, 'old_pass_id' | 'new_pass_id'>,
): Promise<string | null> {
  const held = await all<{ provider: string }>(
    db,
    `SELECT DISTINCT w.provider ${heldFrom('?', '?')} ORDER BY w.provider`,
    [row.old_pass_id, row.new_pass_id],
  );
  return held.length === 0 ? null : `wallet_copy:${held.map((h) => h.provider).join('+')}`;
}

/** A pass's own Google and Samsung switches (`pass_channels`), not retired: what makes the provider's offer show. */
export interface ChannelOverride {
  channel: 'google' | 'samsung';
  override: 'on' | 'off';
}

export function walletOverrides(db: D1Database, passId: string): Promise<ChannelOverride[]> {
  return all<ChannelOverride>(
    db,
    `SELECT channel, override FROM pass_channels
     WHERE pass_id = ? AND channel IN ('google', 'samsung') AND override IS NOT NULL AND retired_at IS NULL
     ORDER BY channel`,
    [passId],
  );
}
