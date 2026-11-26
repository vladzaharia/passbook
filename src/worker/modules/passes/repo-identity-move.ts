import { all, batch, first, run, stmt } from '../../platform/db.ts';

export const DAY_MS = 86_400_000;

export type MoveState =
  | 'planned'
  | 'issued'
  | 'notified'
  | 'registered'
  | 'voided'
  | 'kept'
  | 'failed';

export interface MoveRow {
  id: string;
  op_id: string;
  org_id: string;
  mode: 'live' | 'test';
  from_identity_id: string;
  to_identity_id: string;
  old_pass_id: string;
  new_pass_id: string;
  state: MoveState;
  reason: string | null;
  copied_hash: string | null;
  copied_input: string | null;
  made_input: string | null;
  conflicts: string | null;
  told_at: number | null;
  emailed_at: number | null;
  remind_at: number | null;
  reminded_at: number | null;
  registered_at: number | null;
  armed_device: string | null;
  void_at: number | null;
  claim_until: number | null;
  voided_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MoveParams {
  op_id: string;
  org_id: string;
  from_identity_id: string;
  to_identity_id: string;
}

export const COLUMNS = `id, op_id, org_id, mode, from_identity_id, to_identity_id, old_pass_id, new_pass_id, state,
  reason, copied_hash, copied_input, made_input, conflicts, told_at, emailed_at, remind_at, reminded_at, registered_at, armed_device, void_at, claim_until,
  voided_at, created_at, updated_at`;

/**
 * A registration of the replacement (`r`) that counts: its current credential, on a device that also holds the
 * old pass, or on the one whose add armed the timer (the holder may delete the old pass from it after). Another
 * device's add (a shared or forwarded pass) never starts the old pass's 24 hours.
 */
export const ON_OLD_DEVICE = `r.credential_generation = n.credential_generation
  AND (EXISTS (SELECT 1 FROM pass_moves pm JOIN registrations o ON o.pass_id = pm.old_pass_id
      WHERE pm.new_pass_id = r.pass_id AND o.device_id = r.device_id)
    OR EXISTS (SELECT 1 FROM pass_moves pm WHERE pm.new_pass_id = r.pass_id AND pm.armed_device = r.device_id))`;

/** The registrations that count for the void timer of the replacement `?`. */
export const LIVE_REGISTRATION = `FROM registrations r JOIN passes n ON n.id = r.pass_id
  WHERE r.pass_id = ? AND ${ON_OLD_DEVICE}`;

/** True when this start made the row; false for a repeat of the same start. */
export async function insertParams(db: D1Database, p: MoveParams, now: number): Promise<boolean> {
  const { changes } = await run(
    db,
    `INSERT OR IGNORE INTO identity_moves (op_id, org_id, from_identity_id, to_identity_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [p.op_id, p.org_id, p.from_identity_id, p.to_identity_id, now],
  );
  return changes === 1;
}

/** A start that never made its operation leaves nothing behind. */
export async function dropOrphanParams(db: D1Database, opId: string): Promise<void> {
  await run(
    db,
    `DELETE FROM identity_moves WHERE op_id = ? AND NOT EXISTS (SELECT 1 FROM operations WHERE id = ?)`,
    [opId, opId],
  );
}

export function getParams(db: D1Database, opId: string): Promise<MoveParams | null> {
  return first<MoveParams>(
    db,
    `SELECT op_id, org_id, from_identity_id, to_identity_id FROM identity_moves WHERE op_id = ?`,
    [opId],
  );
}

export interface NewMove {
  id: string;
  oldPassId: string;
  newPassId: string;
  state: 'planned' | 'kept';
  reason: string | null;
}

/** Plans rows; a pass that already has one keeps it (old_pass_id is unique). */
export async function insertMoves(
  db: D1Database,
  p: MoveParams,
  moves: readonly NewMove[],
  now: number,
): Promise<void> {
  await batch(
    db,
    moves.map((m) =>
      stmt(
        db,
        `INSERT OR IGNORE INTO pass_moves (id, op_id, org_id, mode, from_identity_id, to_identity_id,
           old_pass_id, new_pass_id, state, reason, created_at, updated_at)
         VALUES (?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id,
          p.op_id,
          p.org_id,
          p.from_identity_id,
          p.to_identity_id,
          m.oldPassId,
          m.newPassId,
          m.state,
          m.reason,
          now,
          now,
        ],
      ),
    ),
  );
}

/** A cancelled or failed run's open rows go to this run, and every failed row plans again. */
export async function adoptOpen(db: D1Database, p: MoveParams, now: number): Promise<void> {
  await run(
    db,
    `UPDATE pass_moves SET op_id = ?, updated_at = ?,
       state = CASE WHEN state = 'failed' THEN 'planned' ELSE state END,
       reason = CASE WHEN state = 'failed' THEN NULL ELSE reason END
     WHERE org_id = ? AND from_identity_id = ? AND to_identity_id = ?
       AND (state = 'failed' OR (op_id != ? AND state IN ('planned', 'issued')))`,
    [p.op_id, now, p.org_id, p.from_identity_id, p.to_identity_id, p.op_id],
  );
}

export function movesOf(
  db: D1Database,
  q: { opId: string; state: MoveState; after: string; limit: number },
): Promise<MoveRow[]> {
  return all<MoveRow>(
    db,
    `SELECT ${COLUMNS} FROM pass_moves WHERE op_id = ? AND state = ? AND id > ? ORDER BY id LIMIT ?`,
    [q.opId, q.state, q.after, q.limit],
  );
}

export async function countMoves(db: D1Database, opId: string, state: MoveState): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM pass_moves WHERE op_id = ? AND state = ?',
    [opId, state],
  );
  return row?.n ?? 0;
}

export function moveById(db: D1Database, id: string): Promise<MoveRow | null> {
  return first<MoveRow>(db, `SELECT ${COLUMNS} FROM pass_moves WHERE id = ?`, [id]);
}

export function moveByNewPass(db: D1Database, newPassId: string): Promise<MoveRow | null> {
  return first<MoveRow>(db, `SELECT ${COLUMNS} FROM pass_moves WHERE new_pass_id = ?`, [newPassId]);
}

/** One guarded step: it changes the row only from `from`, so a rerun or a racing sweep changes nothing twice. */
export async function setState(
  db: D1Database,
  id: string,
  from: readonly MoveState[],
  to: { state: MoveState; reason?: string | null },
  now: number,
): Promise<boolean> {
  const marks = from.map(() => '?').join(', ');
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = ?, reason = ?, claim_until = NULL, updated_at = ?
     WHERE id = ? AND state IN (${marks})`,
    [to.state, to.reason ?? null, now, id, ...from],
  );
  return changes === 1;
}

export async function markIssued(
  db: D1Database,
  id: string,
  v: {
    copiedHash: string;
    copiedInput: string;
    madeInput: string;
    emailedAt: number | null;
    remindAt: number;
    now: number;
  },
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'issued', copied_hash = ?, copied_input = ?, made_input = ?, emailed_at = ?,
       remind_at = ?, updated_at = ?
     WHERE id = ? AND state = 'planned'`,
    [v.copiedHash, v.copiedInput, v.madeInput, v.emailedAt, v.remindAt, v.now, id],
  );
  return changes === 1;
}

export async function markNotified(
  db: D1Database,
  id: string,
  toldAt: number | null,
  now: number,
): Promise<boolean> {
  const { changes } = await run(
    db,
    `UPDATE pass_moves SET state = 'notified', told_at = ?, updated_at = ? WHERE id = ? AND state = 'issued'`,
    [toldAt, now, id],
  );
  return changes === 1;
}

/** What a carry did: the old input as it now stands (the next base), and the fields both passes edited. */
export async function setCarried(
  db: D1Database,
  id: string,
  v: { hash: string; input: string; conflicts: string | null },
  now: number,
): Promise<void> {
  await run(
    db,
    `UPDATE pass_moves SET copied_hash = ?, copied_input = ?, conflicts = ?, updated_at = ? WHERE id = ?`,
    [v.hash, v.input, v.conflicts, now, id],
  );
}

/** A cancelled run's rows that made no replacement: the passes are free for a later move. */
export async function deleteUnissued(db: D1Database, opId: string): Promise<void> {
  await run(
    db,
    `DELETE FROM pass_moves WHERE op_id = ? AND state = 'planned'
       AND NOT EXISTS (SELECT 1 FROM passes n WHERE n.id = pass_moves.new_pass_id)`,
    [opId],
  );
}

/** When a pass was last written by someone other than a move: its newest version not made by one. */
export async function lastEditAt(db: D1Database, passId: string): Promise<number> {
  const row = await first<{ at: number | null }>(
    db,
    `SELECT max(created_at) AS at FROM pass_versions
     WHERE pass_id = ? AND (source IS NULL OR source NOT LIKE 'move:%')`,
    [passId],
  );
  return row?.at ?? 0;
}
