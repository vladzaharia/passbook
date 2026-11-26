import { all, first, run } from '../../platform/db.ts';
import { COLUMNS, DAY_MS, LIVE_REGISTRATION, type MoveRow } from './repo-identity-move.ts';

/** When the oldest current registration of the replacement was made; null when none is. */
export async function firstRegistrationAt(
  db: D1Database,
  newPassId: string,
): Promise<number | null> {
  const row = await first<{ at: number | null }>(
    db,
    `SELECT min(r.created_at) AS at ${LIVE_REGISTRATION}`,
    [newPassId],
  );
  return row?.at ?? null;
}

/** The replacement registered: from here the old pass voids 24 hours after the first registration. */
export async function arm(db: D1Database, id: string, at: number, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'registered', reason = NULL, registered_at = ?, void_at = ?, updated_at = ?
     WHERE id = ? AND (state IN ('issued', 'notified') OR (state = 'kept' AND reason = 'reminded'))`,
    [at, at + DAY_MS, now, id],
  );
  return changes === 1;
}

/** Open rows whose replacement is registered but whose void timer never started (the hook was missed). */
export function unarmed(db: D1Database, limit: number): Promise<{ id: string; at: number }[]> {
  return all<{ id: string; at: number }>(
    db,
    `SELECT id, at FROM (
       SELECT m.id AS id,
         (SELECT min(r.created_at) FROM registrations r JOIN passes n ON n.id = r.pass_id
          WHERE r.pass_id = m.new_pass_id AND r.credential_generation = n.credential_generation) AS at
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
 * Takes the right to void, only while it still holds: a current registration at least 24 hours old, and a
 * replacement that is still an active pass. One statement, so a register or an unregister racing the timer
 * lands on one side of it.
 */
export async function claimVoid(
  db: D1Database,
  id: string,
  now: number,
  until: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET claim_until = ?, updated_at = ?
     WHERE id = ? AND state = 'registered' AND void_at <= ? AND (claim_until IS NULL OR claim_until <= ?)
       AND EXISTS (SELECT 1 FROM passes n WHERE n.id = pass_moves.new_pass_id AND n.status = 'active'
         AND n.deleted_at IS NULL AND n.removed_at IS NULL)
       AND EXISTS (SELECT 1 FROM registrations r JOIN passes n ON n.id = r.pass_id
         WHERE r.pass_id = pass_moves.new_pass_id AND r.credential_generation = n.credential_generation
           AND r.created_at <= ?)`,
    [until, now, id, now, now, now - DAY_MS],
  );
  return changes === 1;
}

/** The claim failed: the timer waits for the next old-enough registration, or stops when none is left. */
export async function reschedule(
  db: D1Database,
  row: MoveRow,
  now: number,
): Promise<'waiting' | 'disarmed'> {
  const at = await firstRegistrationAt(db, row.new_pass_id);
  if (at === null) {
    await run(
      db,
      `UPDATE pass_moves SET state = 'notified', registered_at = NULL, void_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'registered'`,
      [now, row.id],
    );
    return 'disarmed';
  }
  await run(
    db,
    `UPDATE pass_moves SET registered_at = ?, void_at = ?, updated_at = ? WHERE id = ? AND state = 'registered'`,
    [at, at + DAY_MS, now, row.id],
  );
  return 'waiting';
}

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
