import { stmt } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import type { ScanTenantAuthority } from './actor.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

/** Pin the captured session lifetime for both preview authority checks. */
export function previewSessionLifetime(authority: ScanTenantAuthority): OutputPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM sessions preview_session
      WHERE preview_session.id_hash=? AND preview_session.user_id=?
        AND preview_session.created_at=? AND preview_session.expires_at=?)`,
    params: [
      authority.sessionId,
      authority.userId,
      authority.sessionCreatedAt,
      authority.sessionExpiresAt,
    ],
  };
}

export function previewPreflightAuthority(
  previewAuthority: TenantPassWrite,
  authority: TenantPassWrite,
  lifetime: OutputPredicate,
  csrf: OutputPredicate,
  now: number,
): OutputPredicate {
  return {
    sql: `(${tenantPassAuthoritySql(previewAuthority)}) AND (${tenantPassAuthoritySql(authority)})
        AND (${lifetime.sql}) AND (${csrf.sql})`,
    params: [
      ...tenantPassAuthorityParams(previewAuthority, now),
      ...tenantPassAuthorityParams(authority, now),
      ...lifetime.params,
      ...csrf.params,
    ],
  };
}

export function previewProjectionAuthority(
  pass: OutputPredicate,
  previewAuthority: TenantPassWrite,
  authority: TenantPassWrite,
  lifetime: OutputPredicate,
  now: number,
): OutputPredicate {
  return {
    sql: `(${pass.sql}) AND (${tenantPassAuthoritySql(previewAuthority)})
            AND (${tenantPassAuthoritySql(authority)}) AND (${lifetime.sql})`,
    params: [
      ...pass.params,
      ...tenantPassAuthorityParams(previewAuthority, now),
      ...tenantPassAuthorityParams(authority, now),
      ...lifetime.params,
    ],
  };
}

export function previewCsrfStmt(db: D1Database, csrf: OutputPredicate): D1PreparedStatement {
  return stmt(db, `SELECT 1 AS csrf_authorized WHERE ${csrf.sql}`, csrf.params);
}
