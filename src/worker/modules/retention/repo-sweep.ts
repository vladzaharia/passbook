import { all, stmt } from '../../platform/db.ts';

export type SweepClass = 'scans' | 'events' | 'delivery';

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

const COND: Record<SweepClass, { table: string; sql: string; params: (c: Cutoffs) => number[] }> = {
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
};

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
    `SELECT ${e.table}.id AS id FROM ${e.table} WHERE ${e.sql} LIMIT ${CHUNK}`,
    e.params,
  );
  return rows.map((r) => r.id);
}

const IN_IDS = (table: string) => `${table}.id IN (SELECT value FROM json_each(?))`;

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
    sql: `(SELECT count(*) FROM ${e.table} WHERE ${IN_IDS(e.table)} AND ${e.sql}) = ?`,
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
  const where = `${IN_IDS(e.table)} AND ${e.sql} AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  switch (cls) {
    case 'scans':
      return stmt(db, `DELETE FROM scans WHERE ${where}`, params);
    case 'events':
      return stmt(db, `DELETE FROM pass_events WHERE ${where}`, params);
    case 'delivery':
      return stmt(db, `DELETE FROM outbox WHERE ${where}`, params);
  }
}

/**
 * Ended roll calls leave with the scans window: older than the cutoff, in the scope, and not under a hold
 * (an org-wide one, or one on a pass that is on the call). Their marks go with them. Returns the calls removed.
 */
export async function deleteRollCalls(
  db: D1Database,
  scope: Scope,
  cutoffs: Cutoffs,
): Promise<number> {
  const sc = scopeSql('roll_calls', scope);
  const res = await stmt(
    db,
    `DELETE FROM roll_calls WHERE roll_calls.mode = 'live' AND roll_calls.ended_at < ? AND ${sc.sql}
       AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = roll_calls.org_id
         AND (h.pass_id IS NULL
           OR EXISTS (SELECT 1 FROM roll_call_marks m WHERE m.roll_call_id = roll_calls.id AND m.pass_id = h.pass_id)
           OR EXISTS (SELECT 1 FROM json_each(roll_calls.snapshot) j WHERE json_extract(j.value, '$.passId') = h.pass_id)))`,
    [cutoffs.cutoff, ...sc.params],
  ).run();
  return res.meta.changes ?? 0;
}
