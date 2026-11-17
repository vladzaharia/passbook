import { stmt } from '../../platform/db.ts';
import { type PassLineage, passLineagePredicate } from './repo-history-lineage.ts';
import { scopedHistoryPageStmt } from './repo-history-scoped-page.ts';
import { type OutputPredicate, outputPredicateStmt } from './repo-output-predicates.ts';
import { type HistoryPassScope, historyPassScopePredicate } from './repo-scan-history.ts';

export interface PassScope extends HistoryPassScope {
  credentialKeysetCommitment: string;
  until: number;
}

export const DISPLAY_PAGE_SIZE = 100;

/** One page of the pass's check-ins up to `until`, every disclosure input read in this statement. */
export function displayHistoryPageStmt(
  db: D1Database,
  scope: PassScope,
  offset: number,
  now: number,
): D1PreparedStatement {
  const selected = historyPassScopePredicate(scope, scope.until);
  return scopedHistoryPageStmt(
    db,
    { sql: selected.sql, params: selected.params, limit: DISPLAY_PAGE_SIZE, offset },
    now,
  );
}

/** The size of the whole scope, to prove a follow-on read saw the same set the first page counted. */
export function displayHistoryScopeCountStmt(
  db: D1Database,
  scope: PassScope,
): D1PreparedStatement {
  const selected = historyPassScopePredicate(scope, scope.until);
  return stmt(db, `SELECT COUNT(*) AS n FROM scans s WHERE ${selected.sql}`, selected.params);
}

export function displayHistoryAuthorityStmt(
  db: D1Database,
  current: boolean,
  authority: OutputPredicate,
): D1PreparedStatement {
  return outputPredicateStmt(db, current ? authority : { sql: '0', params: [] });
}

export function displayHistoryCountsStmt(
  db: D1Database,
  scope: OutputPredicate,
  today: number,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT count(*) AS n,COALESCE(SUM(s.at>=?),0) AS today
          FROM scans s WHERE ${scope.sql}`,
    [today, ...scope.params],
  );
}

export function displayHistoryTopStmt(db: D1Database, scope: OutputPredicate): D1PreparedStatement {
  return stmt(
    db,
    `SELECT s.id FROM scans s WHERE ${scope.sql} ORDER BY s.at DESC,s.id DESC LIMIT 3`,
    scope.params,
  );
}

/** One row when the pass is still the one the history was read for. */
export function displayHistoryLineageStmt(
  db: D1Database,
  lineage: PassLineage,
): D1PreparedStatement {
  const current = passLineagePredicate(lineage);
  return stmt(db, `SELECT 1 AS current WHERE ${current.sql}`, current.params);
}
