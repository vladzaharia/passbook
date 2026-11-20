import type { Mode } from '../../../shared/contracts/common.ts';
import { keyHoldsScope, keyLive } from '../../platform/api-key-sql.ts';
import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
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

/** Who started an import: a membership or a key, never a platform session. Ids and revisions only, no secret. */
export type DeferredStarter = Exclude<ReissuePrincipal, { kind: 'platform' }>;

/** The starter names this org and mode: a key's own org and mode, a membership's org (proved by the grant). */
export function starterFits(starter: DeferredStarter, orgId: string, mode: Mode): boolean {
  return (
    starter.kind === 'membership' ||
    (starter.mode === mode && (starter.keyOrgId === null || starter.keyOrgId === orgId))
  );
}

/** The grant principal of a starter: deferred, so every grant re-proves the revisions captured at the start. */
export function starterPrincipal(starter: DeferredStarter, orgId: string, mode: Mode): Principal {
  return starter.kind === 'membership'
    ? {
        kind: 'membership',
        membershipId: starter.membershipId,
        via: 'deferred',
        orgAccessRevision: starter.orgAccessRevision,
        userAccessRevision: starter.userAccessRevision,
        mode,
      }
    : {
        kind: 'api_key',
        keyId: starter.keyId,
        scope: 'passes:write',
        orgAccessRevision: starter.orgAccessRevision,
        ...(starter.keyOrgId === null ? { orgId } : {}),
      };
}

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
 * The SQL that proves the starter still holds the right it started with, as a bare SELECT. `inGrant` is the
 * form a grant check may hold: it never names org_id or mode (the grant owns them), so the org is the
 * actor row's `a.org_id` and the immutable membership or key id stands for its own org and mode.
 */
function principalQuery(
  orgId: string | null,
  principal: ReissuePrincipal,
  now: number,
  inGrant: boolean,
): { sql: string; params: SqlValue[] } {
  if (principal.kind === 'platform') {
    return {
      sql: `SELECT 1 AS ok FROM users u WHERE u.id = ? AND u.status = 'active' AND u.access_revision = ?
      AND json_valid(u.last_roles)
      AND EXISTS (SELECT 1 FROM json_each(u.last_roles) r WHERE r.type = 'text' AND r.value = 'admin')`,
      params: [principal.userId, principal.userAccessRevision],
    };
  }
  if (orgId === null) return { sql: 'SELECT 1 AS ok WHERE 0', params: [] };
  const org = inGrant ? 'o.id = a.org_id' : 'o.id = ?';
  const orgParams: SqlValue[] = inGrant ? [] : [orgId];
  if (principal.kind === 'membership') {
    return {
      sql: `SELECT 1 AS ok FROM org_memberships m
      JOIN users u ON u.id = m.user_id JOIN orgs o ON ${org}${inGrant ? '' : ' AND o.id = m.org_id'}
      WHERE m.id = ? AND m.user_id = ? AND m.revoked_at IS NULL
        AND u.status = 'active' AND u.access_revision = ? AND ${orgEpochMatchSql('o')}
        AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')`,
      params: [
        ...orgParams,
        principal.membershipId,
        principal.userId,
        principal.userAccessRevision,
        ...orgEpochParams(principal.orgAccessRevision),
        JSON.stringify(rolesGranting('passes:operate')),
      ],
    };
  }
  return {
    sql: `SELECT 1 AS ok FROM api_keys k JOIN orgs o ON ${org} AND ${orgEpochMatchSql('o')}
      WHERE k.id = ?${inGrant ? '' : ' AND k.org_id IS ? AND (k.org_id IS NULL OR k.org_id = o.id) AND k.mode = ?'}
        AND ${keyLive('k', now).sql} AND ${keyHoldsScope('k', 'passes:write').sql}`,
    params: [
      ...orgParams,
      ...orgEpochParams(principal.orgAccessRevision),
      principal.keyId,
      ...(inGrant ? [] : [principal.keyOrgId, principal.mode]),
      ...keyLive('k', now).params,
      ...keyHoldsScope('k', 'passes:write').params,
    ],
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
  const q = principalQuery(orgId, principal, now, false);
  return (await first<{ ok: number }>(db, q.sql, q.params)) !== null;
}

/** The same proof as a check of each publish grant, so a revocation mid-page stops the next write. */
export function reissuePrincipalCheck(
  orgId: string | null,
  principal: ReissuePrincipal,
  now: number,
): Check {
  const q = principalQuery(orgId, principal, now, true);
  return rawCheck('actor', `EXISTS (${q.sql})`, q.params);
}
