import { claimPredicate } from './repo-act-claim-lifecycle.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

/** Find the end of a parenthesized SQL expression without looking inside literals or comments. */
function groupEnd(sql: string, start: number): number {
  let depth = 0;
  for (let at = start; at < sql.length; at++) {
    const char = sql[at];
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      at++;
      while (at < sql.length) {
        if (sql[at] === close) {
          if (sql[at + 1] === close) at += 2;
          else break;
        } else at++;
      }
      if (at === sql.length) return -1;
    } else if (char === '-' && sql[at + 1] === '-') {
      const end = sql.indexOf('\n', at + 2);
      if (end < 0) return -1;
      at = end;
    } else if (char === '/' && sql[at + 1] === '*') {
      const end = sql.indexOf('*/', at + 2);
      if (end < 0) return -1;
      at = end + 1;
    } else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return at;
  }
  return -1;
}

/**
 * Only split explicit parenthesized conjunctions. Each original leaf is retained verbatim;
 * ORs, CASE expressions, subqueries and anything not in that form stay together.
 */
function conjunctionLeaves(input: string): string[] {
  const sql = input.trim();
  const groups: string[] = [];
  let at = 0;
  while (at < sql.length && sql[at] === '(') {
    const end = groupEnd(sql, at);
    if (end < 0) return [sql];
    groups.push(sql.slice(at + 1, end));
    at = end + 1;
    if (at === sql.length) return groups.flatMap(conjunctionLeaves);
    const separator = /^\s+AND\s+/i.exec(sql.slice(at));
    if (!separator) return [sql];
    at += separator[0].length;
  }
  return [sql];
}

/** Initialize candidate reads only after the same pristine claim was acquired. */
export function candidateInitializationFence(
  actorKey: string,
  idempotencyKey: string,
  pristine: OutputPredicate,
  guard: OutputPredicate,
) {
  // Keep each original authority conjunct in its own materialized SELECT: the
  // event/release predicate is already deep, and nesting the entire claim guard
  // inside the keyset initializer exceeds D1's expression-depth limit.
  const checks = conjunctionLeaves(guard.sql);
  return claimPredicate(
    `EXISTS (WITH candidate_pristine AS MATERIALIZED (
      SELECT 1 WHERE changes()=1 AND EXISTS (SELECT 1 FROM scans
        WHERE scans.actor_key=?/* scan-ephemeral-actor-key */ AND scans.idempotency_key=?/* scan-ephemeral-idempotency-key */
          AND scans.state='pending' AND (${pristine.sql}))
    ), ${checks
      .map((sql, index) => `candidate_authority_${index} AS MATERIALIZED (SELECT 1 WHERE (${sql}))`)
      .join(', ')}
    SELECT 1 FROM candidate_pristine ${checks
      .map((_, index) => `CROSS JOIN candidate_authority_${index}`)
      .join(' ')})`,
    [actorKey, idempotencyKey, ...pristine.params, ...guard.params],
  );
}
