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

/** The next rowids past the cutoff in the scope, never a held row. */
export async function selectChunk(
  db: D1Database,
  cls: SweepClass,
  scope: Scope,
  cutoffs: Cutoffs,
): Promise<number[]> {
  const { table, sql, params } = COND[cls];
  const scopeSql =
    scope.kind === 'org'
      ? { sql: `${table}.org_id = ?`, params: [scope.orgId] }
      : {
          sql: `${table}.org_id NOT IN (SELECT value FROM json_each(?))`,
          params: [JSON.stringify(scope.exclude)],
        };
  const rows = await all<{ id: number }>(
    db,
    `SELECT ${table}.rowid AS id FROM ${table}
     WHERE ${sql} AND ${scopeSql.sql} AND NOT ${heldSql(table)} LIMIT ${CHUNK}`,
    [...params(cutoffs), ...scopeSql.params],
  );
  return rows.map((r) => r.id);
}

/**
 * Deletes the chosen rows, but only while the receipt that records the delete exists (it is inserted
 * earlier in the same batch) and no hold has been placed since the rows were chosen.
 */
export function deleteChunkStmt(
  db: D1Database,
  cls: SweepClass,
  ids: readonly number[],
  receiptId: string,
): D1PreparedStatement {
  const params = [JSON.stringify(ids), receiptId];
  const gate = `rowid IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM retention_receipts WHERE id = ?)`;
  switch (cls) {
    case 'scans':
      return stmt(db, `DELETE FROM scans WHERE ${gate} AND NOT ${heldSql('scans')}`, params);
    case 'events':
      return stmt(
        db,
        `DELETE FROM pass_events WHERE ${gate} AND NOT ${heldSql('pass_events')}`,
        params,
      );
    case 'delivery':
      return stmt(db, `DELETE FROM outbox WHERE ${gate} AND NOT ${heldSql('outbox')}`, params);
  }
}
