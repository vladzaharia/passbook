import { assertBudget, PARAM_BUDGET } from '../../platform/authority-statements.ts';
import { exactStmt, type SqlValue } from '../../platform/db.ts';
import { RACE_PREDICATE_AUTHORIZED } from './race-tags.ts';

/** A SQL boolean and its binds, in text order. */
export interface ScanPredicate {
  sql: string;
  params: readonly SqlValue[];
  /**
   * CTEs the predicate reads (with their binds), for a statement that carries it: they go in a
   * top-level `WITH`, so their depth does not add to the `WHERE` they guard. Use `withCtes`.
   */
  ctes?: string;
  cteParams?: readonly SqlValue[];
}

/** `sql` with the predicate's CTEs as its top-level `WITH`, and its binds in order (`params` follow the CTEs'). */
export function withCtes(
  predicate: ScanPredicate,
  sql: string,
  params: readonly SqlValue[],
): { sql: string; params: SqlValue[] } {
  return predicate.ctes
    ? {
        sql: `WITH ${predicate.ctes}\n${sql}`,
        params: [...(predicate.cteParams ?? []), ...params],
      }
    : { sql, params: [...params] };
}

/** One `authorized` row (1 or 0) for a predicate, in the batch of the reads it covers. At most 90 binds. */
export function predicateStmt(db: D1Database, predicate: ScanPredicate): D1PreparedStatement {
  const staged = withCtes(
    predicate,
    `${RACE_PREDICATE_AUTHORIZED} SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS authorized`,
    predicate.params,
  );
  assertBudget(staged.sql, staged.params, PARAM_BUDGET);
  return exactStmt(db, staged.sql, staged.params);
}
