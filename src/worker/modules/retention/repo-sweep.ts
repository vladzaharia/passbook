import { all, stmt } from '../../platform/db.ts';

export type SweepClass = 'scans' | 'events' | 'delivery' | 'photos';
/** What a pass deletes from: a class's own table, or a table that ages with it. */
export type SweepTable = SweepClass | 'scan_offline' | 'pass_notes';

/** Days of failed and partial mail kept for support, whatever the class value. */
export const FAILED_MAIL_DAYS = 90;
export const CHUNK = 1000;

export interface Cutoffs {
  /** Rows older than this go (live scans, live events, sent and cancelled mail). */
  cutoff: number;
  /** Failed and partial mail only. */
  failedCutoff: number;
}

export type Scope =
  | { kind: 'platform'; exclude: readonly string[] }
  | { kind: 'org'; orgId: string };

const COND: Record<
  SweepTable,
  { table: string; sql: string; params: (c: Cutoffs) => number[]; idCol?: string }
> = {
  scans: { table: 'scans', sql: "scans.mode = 'live' AND scans.at < ?", params: (c) => [c.cutoff] },
  scan_offline: {
    table: 'scan_offline_reads',
    sql: "scan_offline_reads.mode = 'live' AND scan_offline_reads.synced_at < ?",
    params: (c) => [c.cutoff],
  },
  // Staff notes age with the scans window; they also go with their pass (the cascade).
  pass_notes: {
    table: 'pass_notes',
    sql: "pass_notes.mode = 'live' AND pass_notes.created_at < ?",
    params: (c) => [c.cutoff],
  },
  events: {
    table: 'pass_events',
    sql: "pass_events.mode = 'live' AND pass_events.at < ?",
    params: (c) => [c.cutoff],
  },
  delivery: {
    table: 'outbox',
    sql: `((outbox.state IN ('sent', 'cancelled') AND outbox.finished_at < ?)
      OR (outbox.state IN ('failed', 'partial') AND outbox.finished_at < ?))`,
    params: (c) => [c.cutoff, c.failedCutoff],
  },
  // A photo of a voided or removed pass, once the photo and the pass have both been untouched since the cutoff.
  photos: {
    table: 'member_photos',
    idCol: 'pass_id',
    sql: `member_photos.updated_at < ? AND EXISTS (SELECT 1 FROM passes p
      WHERE p.id = member_photos.pass_id AND p.org_id = member_photos.org_id AND p.modified_at < ?
        AND (p.status = 'voided' OR p.removed_at IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t
        WHERE t.pass_id = member_photos.pass_id AND t.state = 'pending')`,
    params: (c) => [c.cutoff, c.cutoff],
  },
};

const idCol = (cls: SweepTable) => COND[cls].idCol ?? 'id';

/** An org-wide hold, or a hold on this row's pass, keeps the row. */
const heldSql = (table: string) =>
  `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${table}.org_id
     AND (h.pass_id IS NULL OR h.pass_id = ${table}.pass_id))`;

function scopeSql(table: string, scope: Scope): { sql: string; params: string[] } {
  return scope.kind === 'org'
    ? { sql: `${table}.org_id = ?`, params: [scope.orgId] }
    : {
        sql: `${table}.org_id NOT IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(scope.exclude)],
      };
}

/** The class condition, the scope and "no hold": what a row must satisfy to be deleted, at select and at delete. */
function eligible(cls: SweepTable, scope: Scope, cutoffs: Cutoffs) {
  const { table, sql, params } = COND[cls];
  const sc = scopeSql(table, scope);
  return {
    table,
    sql: `${sql} AND ${sc.sql} AND NOT ${heldSql(table)}`,
    params: [...params(cutoffs), ...sc.params],
  };
}

/** The next row ids past the cutoff in the scope, never a held row. */
export async function selectChunk(
  db: D1Database,
  cls: SweepTable,
  scope: Scope,
  cutoffs: Cutoffs,
): Promise<string[]> {
  const e = eligible(cls, scope, cutoffs);
  const rows = await all<{ id: string }>(
    db,
    `SELECT ${e.table}.${idCol(cls)} AS id FROM ${e.table} WHERE ${e.sql} LIMIT ${CHUNK}`,
    e.params,
  );
  return rows.map((r) => r.id);
}

const IN_IDS = (cls: SweepTable) =>
  `${COND[cls].table}.${idCol(cls)} IN (SELECT value FROM json_each(?))`;

/**
 * A condition for the receipt insert: it lands only while exactly `ids.length` of the chosen rows are still
 * eligible, so the receipt's count is what the delete in the same batch removes.
 */
export function receiptGate(
  cls: SweepTable,
  scope: Scope,
  cutoffs: Cutoffs,
  ids: readonly string[],
): { sql: string; params: (string | number)[] } {
  const e = eligible(cls, scope, cutoffs);
  return {
    sql: `(SELECT count(*) FROM ${e.table} WHERE ${IN_IDS(cls)} AND ${e.sql}) = ?`,
    params: [JSON.stringify(ids), ...e.params, ids.length],
  };
}

/**
 * Deletes the chosen rows, but only while they are still eligible (class condition, scope, no hold) and the
 * receipt that records the delete exists (inserted earlier in the same batch).
 */
export function deleteChunkStmt(
  db: D1Database,
  cls: SweepTable,
  scope: Scope,
  cutoffs: Cutoffs,
  ids: readonly string[],
  receiptId: string,
): D1PreparedStatement {
  const e = eligible(cls, scope, cutoffs);
  const params = [JSON.stringify(ids), ...e.params, receiptId];
  const where = `${IN_IDS(cls)} AND (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  switch (cls) {
    case 'scans':
      return stmt(db, `DELETE FROM scans WHERE ${where}`, params);
    case 'scan_offline':
      return stmt(db, `DELETE FROM scan_offline_reads WHERE ${where}`, params);
    case 'pass_notes':
      return stmt(db, `DELETE FROM pass_notes WHERE ${where}`, params);
    case 'events':
      return stmt(db, `DELETE FROM pass_events WHERE ${where}`, params);
    case 'delivery':
      return stmt(db, `DELETE FROM outbox WHERE ${where}`, params);
    case 'photos':
      return stmt(db, `DELETE FROM member_photos WHERE ${where}`, params);
  }
}

/**
 * Photos only, in the delete's batch and gated on its receipt: the delete trigger stages a rollback hold for
 * each object, which a later cleanup job would restore. Move each hold to the deletion queue and drop it, so the
 * rows, the receipt and the queued object delete commit together or not at all.
 */
export function photoRetireStmts(
  db: D1Database,
  ids: readonly string[],
  receiptId: string,
  now: number,
): D1PreparedStatement[] {
  const ofPasses = `c.kind = 'photo' AND c.next_row IS NULL AND c.pass_id IN (SELECT value FROM json_each(?))
    AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  const list = JSON.stringify(ids);
  return [
    stmt(
      db,
      `INSERT INTO pass_transfer_asset_gc (r2_key, transfer_id, source_pass_id, retired_at, next_attempt_at)
       SELECT c.r2_key, NULL, NULL, ?, ? FROM pass_transfer_asset_candidates c
       WHERE ${ofPasses}
         AND NOT EXISTS (SELECT 1 FROM pass_transfer_asset_gc gc WHERE gc.r2_key = c.r2_key)
       GROUP BY c.r2_key`,
      [now, now, list, receiptId],
    ),
    stmt(db, `DELETE FROM pass_transfer_asset_candidates AS c WHERE ${ofPasses}`, [
      list,
      receiptId,
    ]),
  ];
}

/** Ended roll calls: older than the cutoff, in the scope, and not under a hold (org-wide, or on a pass on the call). */
function rollCallsEligible(scope: Scope, cutoffs: Cutoffs) {
  const sc = scopeSql('roll_calls', scope);
  return {
    sql: `roll_calls.mode = 'live' AND roll_calls.ended_at < ? AND ${sc.sql}
       AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = roll_calls.org_id
         AND (h.pass_id IS NULL
           OR EXISTS (SELECT 1 FROM roll_call_marks m WHERE m.roll_call_id = roll_calls.id AND m.pass_id = h.pass_id)
           OR EXISTS (SELECT 1 FROM json_each(roll_calls.snapshot) j WHERE json_extract(j.value, '$.passId') = h.pass_id)))`,
    params: [cutoffs.cutoff, ...sc.params],
  };
}

/** The next ended roll calls past the scans cutoff, never a held one. They leave with the scans window. */
export async function selectRollCalls(
  db: D1Database,
  scope: Scope,
  cutoffs: Cutoffs,
): Promise<string[]> {
  const e = rollCallsEligible(scope, cutoffs);
  const rows = await all<{ id: string }>(
    db,
    `SELECT roll_calls.id AS id FROM roll_calls WHERE ${e.sql} LIMIT ${CHUNK}`,
    e.params,
  );
  return rows.map((r) => r.id);
}

/** A receipt-insert condition: exactly `ids.length` of the chosen calls are still eligible. */
export function rollCallsGate(scope: Scope, cutoffs: Cutoffs, ids: readonly string[]) {
  const e = rollCallsEligible(scope, cutoffs);
  return {
    sql: `(SELECT count(*) FROM roll_calls WHERE roll_calls.id IN (SELECT value FROM json_each(?)) AND ${e.sql}) = ?`,
    params: [JSON.stringify(ids), ...e.params, ids.length],
  };
}

/** Deletes the chosen calls (their marks cascade) only while eligible and the receipt exists. */
export function deleteRollCallsStmt(
  db: D1Database,
  scope: Scope,
  cutoffs: Cutoffs,
  ids: readonly string[],
  receiptId: string,
): D1PreparedStatement {
  const e = rollCallsEligible(scope, cutoffs);
  return stmt(
    db,
    `DELETE FROM roll_calls WHERE roll_calls.id IN (SELECT value FROM json_each(?)) AND (${e.sql}) AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`,
    [JSON.stringify(ids), ...e.params, receiptId],
  );
}
