// Grant.audit: one audit_log row that commits in the grant's batch. Contract: authority-epochs.md section 1.3.
import type { Check } from './authority-checks.ts';
import { type GrantCond, whenSql } from './authority-cond.ts';
import type { GrantScope } from './authority-principal.ts';
import type { BuiltStatement } from './authority-statements.ts';
import type { SqlValue } from './db.ts';

export interface AuditRow {
  at: number;
  /** A non-platform grant writes its own org and requires this to equal it when given. */
  orgId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ipPrefix: string | null;
  /** Already redacted JSON, or null. */
  detail: string | null;
}

export type AuditWhen = GrantCond[];

/**
 * The org column is the grant row's own for a tenant grant: a named `entry.orgId` is a claim the grant
 * insert checks (`org` refusal), never a value the row trusts. A platform grant names any org.
 */
export function buildAudit(
  grantId: string,
  scope: GrantScope,
  entry: AuditRow,
  when?: AuditWhen,
): BuiltStatement {
  const platform = scope === 'platform';
  const params: SqlValue[] = [
    entry.at,
    ...(platform ? [entry.orgId] : []),
    entry.actorType,
    entry.actorId,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.requestId,
    entry.ipPrefix,
    entry.detail,
    grantId,
  ];
  const gate = whenSql(when, scope, params);
  const claimed = entry.orgId;
  const lineage: Check | undefined =
    !platform && claimed !== null
      ? { reason: 'org', ok: (b) => `a.org_id = ${b.bind(claimed)}` }
      : undefined;
  return {
    sql: `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
        SELECT ?, ${platform ? '?' : 'g.org_id'}, ?, ?, ?, ?, ?, ?, ?, ? FROM authority_grants g WHERE g.id = ?${gate}`,
    params,
    ...(lineage ? { lineage } : {}),
  };
}
