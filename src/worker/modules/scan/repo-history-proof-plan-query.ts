import { stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import { historyProofRowsStmt } from './repo-history-proof-read.ts';
import { type HistoryPassScope, historyPassScopePredicate } from './repo-scan-history.ts';

export interface PassScope extends HistoryPassScope {
  credentialKeysetCommitment: string;
  until: number;
}

export function pageStmt(
  ctx: ServiceContext,
  scope: PassScope,
  offset: number,
  includeTotal: boolean,
): D1PreparedStatement {
  const selected = historyPassScopePredicate(scope, scope.until);
  return historyProofRowsStmt(
    ctx,
    { offset, includeTotal },
    selected.sql,
    selected.params,
    scope.credentialKeysetCommitment,
  );
}

export function countStmt(ctx: ServiceContext, scope: PassScope): D1PreparedStatement {
  const selected = historyPassScopePredicate(scope, scope.until);
  return stmt(
    ctx.env.DB,
    `SELECT COUNT(*) AS n FROM scans s LEFT JOIN passes p ON p.id=s.pass_id
    WHERE ${selected.sql} AND ${credentialRefKeysetSql}`,
    [...selected.params, scope.credentialKeysetCommitment],
  );
}
