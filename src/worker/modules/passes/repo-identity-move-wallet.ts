import { all, first } from '../../platform/db.ts';
import type { MoveRow } from './repo-identity-move.ts';

/**
 * When the provider's latest report on a pass is a save, that report's time; else NULL. Neither provider proves a
 * holder's installation, so the reports (`wallet.saved`, `wallet.removed`) are the only evidence a device holds a
 * copy; a later removal clears it.
 */
const savedAt = (pass: string, provider: string) =>
  `(SELECT CASE WHEN e.kind = 'wallet.saved' THEN e.at END FROM pass_events e WHERE e.pass_id = ${pass}
    AND e.kind IN ('wallet.saved', 'wallet.removed') AND json_extract(e.data, '$.provider') = ${provider}
    ORDER BY e.at DESC, e.id DESC LIMIT 1)`;

/** The provider's latest report on a pass: `wallet.saved`, `wallet.removed`, or NULL when it has sent none. */
const latestKind = (pass: string, provider: string) =>
  `(SELECT e.kind FROM pass_events e WHERE e.pass_id = ${pass}
    AND e.kind IN ('wallet.saved', 'wallet.removed') AND json_extract(e.data, '$.provider') = ${provider}
    ORDER BY e.at DESC, e.id DESC LIMIT 1)`;

/** The old pass's live copies the holder saved, one row per provider. */
const savedFrom = (old: string) =>
  `FROM wallet_provider_instances w WHERE w.pass_id = ${old} AND w.lifecycle = 'active'
    AND ${savedAt('w.pass_id', 'w.provider')} IS NOT NULL`;

/** Of those, the ones whose copy of the replacement is not saved: the provider told us. */
const reportedFrom = (old: string, next: string) =>
  `${savedFrom(old)} AND ${savedAt(next, 'w.provider')} IS NULL`;

/**
 * The old pass's live copies that may be saved, whose replacement copy is not: a report that the holder saved
 * one is proof, but no report is not (a callback can be lost), so only the latest report being a removal clears
 * it. Binds a JSON list of the providers that were asked and said nobody has the copy.
 */
const heldFrom = (old: string, next: string) =>
  `FROM wallet_provider_instances w WHERE w.pass_id = ${old} AND w.lifecycle = 'active'
    AND COALESCE(${latestKind('w.pass_id', 'w.provider')} <> 'wallet.removed', 1)
    AND ${savedAt(next, 'w.provider')} IS NULL
    AND w.provider NOT IN (SELECT value FROM json_each(?))`;

/** For `claimVoid`, which reads the row it updates; binds the asked-and-empty providers as a JSON list. */
export const HELD_COPY = `EXISTS (SELECT 1 ${heldFrom('pass_moves.old_pass_id', 'pass_moves.new_pass_id')})`;

/** The row was armed by wallet saves, and the old pass still has a saved copy they answer. */
export const WALLET_ARMED = `(pass_moves.armed_device = 'wallet'
  AND EXISTS (SELECT 1 ${savedFrom('pass_moves.old_pass_id')}))`;

/** A replacement copy of a provider the old pass had saved was saved after `?`: its 24 hours have not run. */
export const RECENT_SAVE = `EXISTS (SELECT 1 ${savedFrom('pass_moves.old_pass_id')}
  AND ${savedAt('pass_moves.new_pass_id', 'w.provider')} > ?)`;

/** `wallet_copy:google`, `wallet_copy:samsung` or `wallet_copy:google+samsung`: the row's reason; null when none is held. */
export async function heldReason(
  db: D1Database,
  row: Pick<MoveRow, 'old_pass_id' | 'new_pass_id'>,
  cleared: readonly string[] = [],
): Promise<string | null> {
  const held = await all<{ provider: string }>(
    db,
    `SELECT DISTINCT w.provider ${heldFrom('?', '?')} ORDER BY w.provider`,
    [row.old_pass_id, row.new_pass_id, JSON.stringify(cleared)],
  );
  return held.length === 0 ? null : `wallet_copy:${held.map((h) => h.provider).join('+')}`;
}

/**
 * The old pass has a live Google copy that no report speaks of, and the replacement's is not saved: Google is
 * asked whether the object has users before the old pass is voided.
 */
export async function unconfirmedGoogle(
  db: D1Database,
  row: Pick<MoveRow, 'old_pass_id' | 'new_pass_id'>,
): Promise<boolean> {
  const hit = await first<{ one: number }>(
    db,
    `SELECT 1 AS one FROM wallet_provider_instances w WHERE w.pass_id = ? AND w.provider = 'google'
       AND w.lifecycle = 'active' AND ${latestKind('w.pass_id', 'w.provider')} IS NULL
       AND ${savedAt('?', 'w.provider')} IS NULL`,
    [row.old_pass_id, row.new_pass_id],
  );
  return hit !== null;
}

/** A holder with no Apple registration: the 24 hours run from the last save the replacement needed. */
const ARMABLE = `NOT EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = m.old_pass_id)
  AND EXISTS (SELECT 1 ${savedFrom('m.old_pass_id')})
  AND NOT EXISTS (SELECT 1 ${reportedFrom('m.old_pass_id', 'm.new_pass_id')})`;
const LAST_SAVE = `(SELECT MAX(${savedAt('m.new_pass_id', 'w.provider')}) ${savedFrom('m.old_pass_id')})`;

/**
 * Open rows whose holder saved the replacement in every provider they had saved the old pass in, with no Apple
 * registration of the old pass to wait for (a holder with one arms on the replacement's registration instead).
 */
export function walletArmable(
  db: D1Database,
  limit: number,
): Promise<{ id: string; at: number }[]> {
  return all<{ id: string; at: number }>(
    db,
    `SELECT m.id AS id, ${LAST_SAVE} AS at FROM pass_moves m
     WHERE (m.state IN ('issued', 'notified') OR (m.state = 'kept' AND m.reason = 'reminded')) AND ${ARMABLE}
       AND EXISTS (SELECT 1 FROM passes o WHERE o.id = m.old_pass_id AND o.status = 'active'
         AND o.removed_at IS NULL AND o.deleted_at IS NULL)
     LIMIT ?`,
    [limit],
  );
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

/** The identity the old pass is on has stopped issuing: nothing is left to wait for. */
export async function identityRetired(
  db: D1Database,
  row: Pick<MoveRow, 'from_identity_id'>,
): Promise<boolean> {
  const hit = await first<{ issuing: number }>(
    db,
    'SELECT issuing FROM signing_identities WHERE id = ?',
    [row.from_identity_id],
  );
  return hit?.issuing === 0;
}
