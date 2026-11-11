import { stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

const credentialKeysetFenceSql = credentialRefKeysetSql.replace('?', '?/* scan-ephemeral-proof */');

export function statsGuard(authority: OutputPredicate, commitment: string): OutputPredicate {
  return {
    sql: `(${authority.sql}) AND (${credentialKeysetFenceSql})`,
    params: [...authority.params, commitment],
  };
}

export function statsKeysetCurrentStmt(db: D1Database, commitment: string): D1PreparedStatement {
  return stmt(db, `SELECT (${credentialKeysetFenceSql}) AS current`, [commitment]);
}
