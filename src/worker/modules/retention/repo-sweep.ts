import { all, stmt } from '../../platform/db.ts';

export type SweepClass = 'scans' | 'events' | 'delivery' | 'photos';

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
  SweepClass,
  { table: string; sql: string; params: (c: Cutoffs) => number[]; idCol?: string }
> = {
  scans: { table: 'scans', sql: "scans.mode = 'live' AND scans.at < ?", params: (c) => [c.cutoff] },
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
        AND (p.status = 'voided' OR p.removed_at IS NOT NULL))`,
    params: (c) => [c.cutoff, c.cutoff],
  },
};

const idCol = (cls: SweepClass) => COND[cls].idCol ?? 'id';

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
function eligible(cls: SweepClass, scope: Scope, cutoffs: Cutoffs) {
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
  cls: SweepClass,
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

const IN_IDS = (cls: SweepClass) =>
  `${COND[cls].table}.${idCol(cls)} IN (SELECT value FROM json_each(?))`;

/**
 * A condition for the receipt insert: it lands only while exactly `ids.length` of the chosen rows are still
 * eligible, so the receipt's count is what the delete in the same batch removes.
 */
export function receiptGate(
  cls: SweepClass,
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
  cls: SweepClass,
  scope: Scope,
  cutoffs: Cutoffs,
  ids: readonly string[],
  receiptId: string,
): D1PreparedStatement {
  const e = eligible(cls, scope, cutoffs);
  const params = [JSON.stringify(ids), ...e.params, receiptId];
  const where = `${IN_IDS(cls)} AND ${e.sql} AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  switch (cls) {
    case 'scans':
      return stmt(db, `DELETE FROM scans WHERE ${where}`, params);
    case 'events':
      return stmt(db, `DELETE FROM pass_events WHERE ${where}`, params);
    case 'delivery':
      return stmt(db, `DELETE FROM outbox WHERE ${where}`, params);
    case 'photos':
      return stmt(db, `DELETE FROM member_photos WHERE ${where}`, params);
  }
}
