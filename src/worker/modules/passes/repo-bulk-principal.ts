import type { Mode } from '../../../shared/contracts/common.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { TenantPassWrite } from './http.ts';
import { loadUserAccessRevision } from './repo-access-revision.ts';
import { orgEpochMatchSql, orgEpochParams } from './repo-authority.ts';

/** Who started a bulk rebuild, with the revisions captured then. The run has no session to carry. */
export type ReissuePrincipal =
  | {
      kind: 'membership';
      membershipId: string;
      userId: string;
      userAccessRevision: number;
      orgAccessRevision: number;
    }
  | {
      kind: 'api_key';
      keyId: string;
      keyOrgId: string | null;
      mode: Mode;
      orgAccessRevision: number;
    }
  | { kind: 'platform'; userId: string; userAccessRevision: number };

/** The principal behind a start request, captured once the start is authorized. */
export async function reissuePrincipalOf(
  db: D1Database,
  authority: TenantPassWrite | undefined,
  platformSession: { userId: string } | undefined,
): Promise<ReissuePrincipal | undefined> {
  if (authority?.kind === 'session') {
    return {
      kind: 'membership',
      membershipId: authority.membershipId,
      userId: authority.userId,
      userAccessRevision:
        authority.userAccessRevision ?? (await loadUserAccessRevision(db, authority.userId)) ?? 0,
      orgAccessRevision: authority.orgAccessRevision,
    };
  }
  if (authority) {
    return {
      kind: 'api_key',
      keyId: authority.keyId,
      keyOrgId: authority.keyOrgId,
      mode: authority.mode,
      orgAccessRevision: authority.orgAccessRevision,
    };
  }
  if (!platformSession) return undefined;
  return {
    kind: 'platform',
    userId: platformSession.userId,
    userAccessRevision: (await loadUserAccessRevision(db, platformSession.userId)) ?? 0,
  };
}

/**
 * The starter still holds the right it started with: an unrevoked membership (or key) that still grants
 * `passes:operate` (or `passes:write`), an active user at the captured `access_revision`, and an org that is
 * active at the captured revision. A platform admin must still have signed in as an admin.
 */
export async function reissuePrincipalValid(
  db: D1Database,
  orgId: string | null,
  principal: ReissuePrincipal,
  now: number,
): Promise<boolean> {
  let sql: string;
  let params: SqlValue[];
  if (principal.kind === 'platform') {
    sql = `SELECT 1 AS ok FROM users u WHERE u.id = ? AND u.status = 'active' AND u.access_revision = ?
      AND json_valid(u.last_roles)
      AND EXISTS (SELECT 1 FROM json_each(u.last_roles) r WHERE r.type = 'text' AND r.value = 'admin')`;
    params = [principal.userId, principal.userAccessRevision];
  } else if (orgId === null) {
    return false;
  } else if (principal.kind === 'membership') {
    sql = `SELECT 1 AS ok FROM org_memberships m
      JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id
      WHERE m.id = ? AND m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL
        AND u.status = 'active' AND u.access_revision = ? AND ${orgEpochMatchSql('o')}
        AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')`;
    params = [
      principal.membershipId,
      orgId,
      principal.userId,
      principal.userAccessRevision,
      ...orgEpochParams(principal.orgAccessRevision),
      JSON.stringify(rolesGranting('passes:operate')),
    ];
  } else {
    sql = `SELECT 1 AS ok FROM api_keys k JOIN orgs o ON o.id = ? AND ${orgEpochMatchSql('o')}
      WHERE k.id = ? AND k.org_id IS ? AND (k.org_id IS NULL OR k.org_id = o.id) AND k.mode = ?
        AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
        AND EXISTS (SELECT 1 FROM json_each(k.scopes) s WHERE s.type = 'text' AND s.value = 'passes:write')`;
    params = [
      orgId,
      ...orgEpochParams(principal.orgAccessRevision),
      principal.keyId,
      principal.keyOrgId,
      principal.mode,
      now,
    ];
  }
  return (await first<{ ok: number }>(db, sql, params)) !== null;
}
