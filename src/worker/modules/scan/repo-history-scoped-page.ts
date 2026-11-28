import { type SqlValue, stmt } from '../../platform/db.ts';
import { RACE_HISTORY_PAGE } from './race-tags.ts';
import { HISTORY_COLUMNS, HISTORY_JOINS } from './repo-history-rows.ts';

/** The scans of one history read that has no actor fence of its own: its caller holds one. */
export interface ScopedHistorySelector {
  /** Conditions over the scan alias `s`, including the tenant and the ledger scope. */
  sql: string;
  params: readonly SqlValue[];
  limit: number;
  offset?: number;
}

/**
 * The history page statement (`repo-history-rows.ts` columns and joins) over scans a caller names
 * by scope, newest first. Every column of every row comes from this statement's snapshot;
 * `candidate_total` is the size of the whole scope.
 */
export function scopedHistoryPageStmt(
  db: D1Database,
  sel: ScopedHistorySelector,
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `WITH ${RACE_HISTORY_PAGE} page AS MATERIALIZED (
      SELECT s.id AS scan_id, COUNT(*) OVER () AS candidate_total FROM scans s
      WHERE ${sel.sql} ORDER BY s.at DESC, s.id DESC LIMIT ? OFFSET ?)
    SELECT ${HISTORY_COLUMNS}, page.candidate_total FROM page ${HISTORY_JOINS}
    ORDER BY s.at DESC, s.id DESC`,
    [...sel.params, sel.limit, sel.offset ?? 0, now],
  );
}
