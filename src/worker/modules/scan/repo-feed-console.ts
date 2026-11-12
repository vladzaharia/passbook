import { first, stmt } from '../../platform/db.ts';
import { UnavailableError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

type Db = D1Database;

/** Keep the session secret in direct scalar binds, not in packed output JSON. */
export async function consoleFeedAuthorityCurrent(
  db: Db,
  guard: OutputPredicate,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  const result = await first<{ authorized: number; keyset_current: number }>(
    db,
    `SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END AS authorized,
      CASE WHEN ${credentialRefKeysetSql} THEN 1 ELSE 0 END AS keyset_current`,
    [...guard.params, credentialKeysetCommitment],
  );
  if (result?.keyset_current !== 1)
    throw new UnavailableError(
      'Credential references are unavailable.',
      'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    );
  return result.authorized === 1;
}

/** Audit an export only while the same tenant session and membership are still authorized. */
export function scanExportAuditStmt(
  db: Db,
  ctx: Pick<ServiceContext, 'clock' | 'requestId'>,
  authority: Extract<TenantPassWrite, { kind: 'session' }>,
  detail: { from: number; to: number; rows: number },
  credentialKeysetCommitment: string,
  guard: OutputPredicate,
): D1PreparedStatement {
  const now = ctx.clock.now();
  return stmt(
    db,
    `INSERT INTO audit_log
      (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
     SELECT ?, ?, 'user', ?, 'scan.export', 'org', ?, ?, NULL, ?
     WHERE ${tenantPassAuthoritySql(authority)} AND (${guard.sql}) AND ${credentialRefKeysetSql}`,
    [
      now,
      authority.orgId,
      authority.userId,
      authority.orgId,
      ctx.requestId,
      JSON.stringify(redactDetail(detail)),
      ...tenantPassAuthorityParams(authority, now),
      ...guard.params,
      credentialKeysetCommitment,
    ],
  );
}
