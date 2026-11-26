import { all, first, run } from '../../platform/db.ts';
import {
  COLUMNS,
  DAY_MS,
  LIVE_REGISTRATION,
  type MoveRow,
  ON_OLD_DEVICE,
} from './repo-identity-move.ts';
import { KEPT } from './repo-identity-move-candidates.ts';
import { HELD_COPY, RECENT_SAVE, WALLET_ARMED } from './repo-identity-move-wallet.ts';

/** The oldest registration of the replacement that counts, or null when none does. */
export function firstRegistration(
  db: D1Database,
  newPassId: string,
): Promise<{ at: number; device: string } | null> {
  return first<{ at: number; device: string }>(
    db,
    `SELECT r.created_at AS at, r.device_id AS device ${LIVE_REGISTRATION} ORDER BY r.created_at LIMIT 1`,
    [newPassId],
  );
}

/** The oldest current registration of the replacement on any device: an admin may arm on it. */
export function anyRegistration(
  db: D1Database,
  newPassId: string,
): Promise<{ at: number; device: string } | null> {
  return first<{ at: number; device: string }>(
    db,
    `SELECT r.created_at AS at, r.device_id AS device FROM registrations r JOIN passes n ON n.id = r.pass_id
     WHERE r.pass_id = ? AND r.credential_generation = n.credential_generation ORDER BY r.created_at LIMIT 1`,
    [newPassId],
  );
}

/** A registration this old on a device that never armed the void is a state worth a look. */
export const UNARMED_AFTER_MS = 7 * DAY_MS;

/**
 * Marks open rows whose replacement has been registered for 7 days without the void arming (the device id of
 * the two pass types may differ), and returns the rows newly marked. The mark clears when the void arms.
 */
export function flagUnarmed(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ id: string; org_id: string }[]> {
  return all<{ id: string; org_id: string }>(
    db,
    `UPDATE pass_moves SET reason = 'unarmed', updated_at = ?1
     WHERE id IN (SELECT m.id FROM pass_moves m
       WHERE m.state IN ('issued', 'notified') AND m.reason IS NULL
         AND EXISTS (SELECT 1 FROM registrations r JOIN passes n ON n.id = r.pass_id
           WHERE r.pass_id = m.new_pass_id AND r.credential_generation = n.credential_generation
             AND r.created_at <= ?2)
       LIMIT ?3)
     RETURNING id, org_id`,
    [now, now - UNARMED_AFTER_MS, limit],
  );
}

/** The replacement registered: from here the old pass voids 24 hours after the first registration. */
export async function arm(
  db: D1Database,
  id: string,
  reg: { at: number; device: string },
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'registered', reason = NULL, registered_at = ?, void_at = ?, armed_device = ?,
       updated_at = ?
     WHERE id = ? AND (state IN ('issued', 'notified') OR (state = 'kept' AND reason = 'reminded'))`,
    [reg.at, reg.at + DAY_MS, reg.device, now, id],
  );
  return changes === 1;
}

/** Open rows whose replacement is registered but whose void timer never started (the hook was missed). */
export function unarmed(
  db: D1Database,
  limit: number,
): Promise<{ id: string; at: number; device: string }[]> {
  return all<{ id: string; at: number; device: string }>(
    db,
    `SELECT id, at, device FROM (
       SELECT m.id AS id,
         (SELECT r.created_at FROM registrations r JOIN passes n ON n.id = r.pass_id
          WHERE r.pass_id = m.new_pass_id AND ${ON_OLD_DEVICE} ORDER BY r.created_at LIMIT 1) AS at,
         (SELECT r.device_id FROM registrations r JOIN passes n ON n.id = r.pass_id
          WHERE r.pass_id = m.new_pass_id AND ${ON_OLD_DEVICE} ORDER BY r.created_at LIMIT 1) AS device
       FROM pass_moves m
       WHERE m.state IN ('issued', 'notified') OR (m.state = 'kept' AND m.reason = 'reminded'))
     WHERE at IS NOT NULL LIMIT ?`,
    [limit],
  );
}

export function dueVoids(db: D1Database, now: number, limit: number): Promise<MoveRow[]> {
  return all<MoveRow>(
    db,
    `SELECT ${COLUMNS} FROM pass_moves
     WHERE state = 'registered' AND void_at <= ? AND (claim_until IS NULL OR claim_until <= ?)
     ORDER BY void_at LIMIT ?`,
    [now, now, limit],
  );
}

/**
 * Takes the right to void, only while it still holds, however the row was armed: a current registration at least
 * 24 hours old (or wallet saves that armed it), a replacement that is still an active pass, an old pass that can
 * still move (the plan's kept reasons are read again here), no device registered to the old pass without the
 * replacement, no wallet copy that may be saved while the replacement's is not, and the replacement's saves a
 * day old. One statement, so a register or an unregister racing the timer lands on one side of it.
 */
export async function claimVoid(
  db: D1Database,
  id: string,
  now: number,
  until: number,
  /** Providers Google was asked about and said nobody has the copy. */
  cleared: readonly string[] = [],
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET claim_until = ?, updated_at = ?, reason = NULL
     WHERE id = ? AND state = 'registered' AND void_at <= ? AND (claim_until IS NULL OR claim_until <= ?)
       AND EXISTS (SELECT 1 FROM passes n WHERE n.id = pass_moves.new_pass_id AND n.status = 'active'
         AND n.deleted_at IS NULL AND n.removed_at IS NULL)
       AND (EXISTS (SELECT 1 FROM registrations r JOIN passes n ON n.id = r.pass_id
         WHERE r.pass_id = pass_moves.new_pass_id AND ${ON_OLD_DEVICE} AND r.created_at <= ?)
         OR ${WALLET_ARMED})
       AND (SELECT ${KEPT} FROM passes p WHERE p.id = pass_moves.old_pass_id) IS NULL
       AND NOT EXISTS (SELECT 1 FROM registrations o JOIN passes op ON op.id = o.pass_id
         AND o.credential_generation = op.credential_generation
         WHERE o.pass_id = pass_moves.old_pass_id AND NOT EXISTS (SELECT 1 FROM registrations r
           WHERE r.pass_id = pass_moves.new_pass_id AND r.device_id = o.device_id))
       AND NOT ${HELD_COPY} AND NOT ${RECENT_SAVE}`,
    [until, now, id, now, now, now - DAY_MS, JSON.stringify(cleared), now - DAY_MS],
  );
  return changes === 1;
}

/** The claim failed: the timer waits for the next old-enough registration, or stops when none is left. */
export async function reschedule(
  db: D1Database,
  row: MoveRow,
  now: number,
): Promise<'waiting' | 'disarmed'> {
  const found = await firstRegistration(db, row.new_pass_id);
  if (found === null) {
    await run(
      db,
      `UPDATE pass_moves SET state = 'notified', registered_at = NULL, void_at = NULL, armed_device = NULL,
         updated_at = ?
       WHERE id = ? AND state = 'registered'`,
      [now, row.id],
    );
    return 'disarmed';
  }
  await run(
    db,
    `UPDATE pass_moves SET registered_at = ?, void_at = ?, armed_device = ?, updated_at = ?
     WHERE id = ? AND state = 'registered'`,
    [found.at, found.at + DAY_MS, found.device, now, row.id],
  );
  return 'waiting';
}

/**
 * Closes the row of a voided old pass. `replaced_by` was set in the void's own batch, so writes by the old id
 * already go to the replacement. True when this call closed the row.
 */
export async function finishVoid(db: D1Database, id: string, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'voided', voided_at = ?, claim_until = NULL, updated_at = ?
     WHERE id = ? AND state = 'registered'`,
    [now, now, id],
  );
  return changes === 1;
}

export function dueReminders(db: D1Database, now: number, limit: number): Promise<MoveRow[]> {
  return all<MoveRow>(
    db,
    `SELECT ${COLUMNS} FROM pass_moves
     WHERE state IN ('issued', 'notified') AND reminded_at IS NULL AND remind_at <= ?
     ORDER BY remind_at LIMIT ?`,
    [now, limit],
  );
}

/** Takes the one reminder: the row is `kept` (the old pass stays), and a registration still revives it. */
export async function claimReminder(
  db: D1Database,
  id: string,
  from: 'issued' | 'notified',
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'kept', reason = 'reminded', reminded_at = ?, updated_at = ?
     WHERE id = ? AND state = ? AND reminded_at IS NULL`,
    [now, now, id, from],
  );
  return changes === 1;
}

/** The reminder did not go out: put the row back and try again at `next`. */
export async function unclaimReminder(
  db: D1Database,
  id: string,
  back: 'issued' | 'notified',
  next: number,
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE pass_moves SET state = ?, reason = NULL, reminded_at = NULL, remind_at = ?, updated_at = ?
     WHERE id = ? AND state = 'kept' AND reason = 'reminded'`,
    [back, next, now, id],
  );
}

/** The ref of the version that voids the old pass at the end of its 24 hours: the move's own void. */
export const voidRef = (moveId: string) => `void:${moveId}`;

/**
 * Open rows whose old pass was revoked: voided, removed or deleted by someone else. A row mid-void holds a claim,
 * and one whose void landed before a crash has its own void version; neither is a revocation.
 */
export function revokedOld(db: D1Database, now: number, limit: number): Promise<MoveRow[]> {
  return all<MoveRow>(
    db,
    `SELECT ${COLUMNS} FROM pass_moves
     WHERE (state IN ('issued', 'notified', 'kept_both') OR (state = 'kept' AND reason = 'reminded')
         OR (state = 'registered' AND (claim_until IS NULL OR claim_until <= ?)))
       AND NOT EXISTS (SELECT 1 FROM passes o WHERE o.id = pass_moves.old_pass_id AND o.status = 'active'
         AND o.removed_at IS NULL AND o.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM pass_versions v WHERE v.pass_id = pass_moves.old_pass_id
         AND v.source = 'move:void:' || pass_moves.id)
     LIMIT ?`,
    [now, limit],
  );
}

/** True when the old pass's void is the move's own (a crash left the row `registered`). */
export async function voidedByMove(db: D1Database, row: MoveRow): Promise<boolean> {
  const hit = await first<{ one: number }>(
    db,
    'SELECT 1 AS one FROM pass_versions WHERE pass_id = ? AND source = ? LIMIT 1',
    [row.old_pass_id, `move:${voidRef(row.id)}`],
  );
  return hit !== null;
}

/** The wait's reason, shown while the row is `registered`. */
export async function setWaitReason(
  db: D1Database,
  id: string,
  reason: string | null,
  now: number,
  /** The next look at the row, when the wait cost a provider read. */
  retryAt: number | null = null,
): Promise<void> {
  await run(
    db,
    `UPDATE pass_moves SET reason = ?, updated_at = ?, void_at = MAX(void_at, COALESCE(?, 0))
     WHERE id = ? AND state = 'registered'`,
    [reason, now, retryAt, id],
  );
}
