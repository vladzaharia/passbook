import { first, type SqlValue } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import {
  orgEpochMatchSql,
  orgEpochParams,
  tenantPassAuthorityParams,
  tenantPassAuthoritySql,
} from '../passes/repo-authority.ts';
import type { TemplateAuthority } from './access.ts';

/** Bind a captured grant to the actual row and recheck it at the D1 statement. */
export function templateAuthorityPredicate(
  authority: TemplateAuthority,
  orgSql: string,
  now: number,
  deferred = false,
): { sql: string; params: SqlValue[] } {
  if (deferred) return deferredPredicate(authority, orgSql);
  if (authority.kind === 'session') {
    if (
      authority.capability !== 'templates:author' &&
      authority.capability !== 'templates:review' &&
      authority.capability !== 'templates:publish'
    )
      return { sql: `((${orgSql}) IS NULL AND 0)`, params: [] };
    return {
      sql: `(${orgSql}) = ? AND (${tenantPassAuthoritySql(authority)})`,
      params: [authority.orgId, ...tenantPassAuthorityParams(authority, now)],
    };
  }
  // Reject incomplete snapshots even if an untyped caller supplies a bare platform tag.
  if (typeof authority.userId !== 'string' || typeof authority.sessionId !== 'string')
    return { sql: `((${orgSql}) IS NULL AND 0)`, params: [] };
  return {
    sql: `(${orgSql}) IS NULL AND EXISTS (
      SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.user_id = ? AND u.status = 'active'
        AND s.revoked_at IS NULL AND s.expires_at > ? AND s.idle_expires_at > ?
        AND json_type(s.roles) = 'array'
        AND EXISTS (SELECT 1 FROM json_each(s.roles) r WHERE r.value = 'admin')
    )`,
    params: [authority.sessionId, authority.userId, now, now],
  };
}

/**
 * Queued work (an import) outlives the request's session (owner answer 2): the membership must be
 * unrevoked, the user active and the org active at the `access_revision` captured with the work.
 */
function deferredPredicate(
  authority: TemplateAuthority,
  orgSql: string,
): { sql: string; params: SqlValue[] } {
  if (authority.kind === 'platform')
    return {
      sql: `(${orgSql}) IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.status = 'active'
        AND json_valid(u.last_roles) AND EXISTS (SELECT 1 FROM json_each(u.last_roles) r WHERE r.value = 'admin'))`,
      params: [authority.userId],
    };
  return {
    sql: `(${orgSql}) = ? AND EXISTS (
      SELECT 1 FROM org_memberships m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id
      WHERE m.id = ? AND m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL
        AND u.status = 'active' AND ${orgEpochMatchSql('o')}
        AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')
    )`,
    params: [
      authority.orgId,
      authority.membershipId,
      authority.orgId,
      authority.userId,
      ...orgEpochParams(authority.orgUpdatedAt),
      JSON.stringify(rolesGranting(authority.capability)),
    ],
  };
}

/** Recheck a captured grant immediately before a non-D1 side effect. */
export async function hasTemplateAuthority(
  db: D1Database,
  authority: TemplateAuthority,
  now: number,
  deferred = false,
): Promise<boolean> {
  const predicate = templateAuthorityPredicate(authority, '?', now, deferred);
  const row = await first<{ ok: number }>(db, `SELECT 1 AS ok WHERE ${predicate.sql}`, [
    authority.kind === 'session' ? authority.orgId : null,
    ...predicate.params,
  ]);
  return !!row;
}
