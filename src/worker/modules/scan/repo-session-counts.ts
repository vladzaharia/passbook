import { type SqlValue, stmt } from '../../platform/db.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export function unrestrictedSessionCountScope(): { sql: string; params: SqlValue[] } {
  return { sql: '1', params: [] };
}

export function sessionCountGuardPredicate(
  guard: OutputPredicate,
  scope: OutputPredicate,
): { sql: string; params: SqlValue[] } {
  return { sql: `(${guard.sql}) AND (${scope.sql})`, params: [...guard.params, ...scope.params] };
}

export function sessionCountStatusStmt(
  db: D1Database,
  guard: OutputPredicate,
  scope: OutputPredicate,
): D1PreparedStatement {
  return stmt(db, `SELECT (${guard.sql}) AS authorized, (${scope.sql}) AS scope_current`, [
    ...guard.params,
    ...scope.params,
  ]);
}
