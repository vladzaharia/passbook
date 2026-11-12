import { stmt } from '../../platform/db.ts';
import { scanCandidateTemplateReadPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export function currentFoundTemplate(candidate: Candidate): OutputPredicate | null {
  const template = scanCandidateTemplateReadPredicate(candidate);
  return template.sql === '0' ? null : template;
}

export function currentFoundExtra(
  csrf: OutputPredicate,
  template: OutputPredicate,
): OutputPredicate {
  return {
    sql: `(${csrf.sql}) AND (${template.sql})`,
    params: [...csrf.params, ...template.params],
  };
}

export function currentFoundActorStmt(db: D1Database, csrf: OutputPredicate): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN (${csrf.sql}) THEN 1 ELSE 0 END AS actor_authorized`,
    csrf.params,
  );
}
