import type { OrgCapability } from '../../../shared/contracts/org-membership.ts';
import { type Check, rawCheck } from '../../platform/authority-checks.ts';
import { LEGACY_REVISION_MS, type Principal } from '../../platform/authority-principal.ts';
import { first, type SqlValue } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';
import type { TenantPassWrite } from './http.ts';

/**
 * Work queued by the pre-0052 Worker persisted `orgs.updated_at` (milliseconds) as its org revision. Such a
 * value can never equal an `access_revision`, so it is accepted on org status alone. Remove this, with
 * `orgEpochParams`, one release after cutover, when no such work can remain.
 */
/** `o` is active and, unless the bound value is a legacy `updated_at`, at the captured access revision. */
export const orgEpochMatchSql = (alias: string) =>
  `${alias}.status = 'active' AND (? >= ${LEGACY_REVISION_MS} OR ${alias}.access_revision = ?)`;
export const orgEpochParams = (revision: number): [number, number] => [revision, revision];
const legacyRevision = (revision: number) =>
  revision >= LEGACY_REVISION_MS ? {} : { orgAccessRevision: revision };

/**
 * Commit-time authority: the principal is live now and the org's `access_revision` is the one captured
 * with `authority`. Roles, scopes and session identity are immutable (authority-epochs.md Rule 2), so
 * they are not compared as JSON snapshots; the capability and scope are still re-derived from the
 * membership's own roles and the key's own scopes, so a hand-built snapshot cannot claim more.
 * A branding or settings save never moves the revision.
 * The caller must also bind its target row to authority.orgId, either by providing its SQL table alias
 * here or by including an equivalent predicate in the mutation. The alias is a static SQL identifier.
 */
export function tenantPassAuthoritySql(authority: TenantPassWrite, tableAlias?: string): string {
  if (tableAlias !== undefined && !/^[a-z_][a-z0-9_]*$/i.test(tableAlias))
    throw new Error('Invalid tenant authority table alias.');
  const target = tableAlias ? `${tableAlias}.org_id = ?` : '? IS NOT NULL';
  if (authority.kind === 'session') {
    return `(${target} AND EXISTS (
      SELECT 1 FROM org_memberships m
      JOIN users u ON u.id = m.user_id
      JOIN orgs o ON o.id = m.org_id
      WHERE m.id = ? AND m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL
        AND u.status = 'active' AND ${orgEpochMatchSql('o')}
        AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_hash = ?/* scan-ephemeral-session-id-hash */
          AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ? AND s.idle_expires_at > ?)
        AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text')
    ))`;
  }
  return `(${target} AND EXISTS (
    SELECT 1 FROM api_keys k JOIN orgs o ON o.id = ? AND ${orgEpochMatchSql('o')}
    WHERE k.id = ? AND k.org_id IS ? AND (k.org_id IS NULL OR k.org_id = o.id)
      AND k.mode = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
      AND EXISTS (SELECT 1 FROM json_each(k.scopes) required WHERE required.type = 'text' AND required.value = ?)
  ))`;
}

/** Parameters are independent of whether tenantPassAuthoritySql was given a table alias. */
export function tenantPassAuthorityParams(authority: TenantPassWrite, now: number): SqlValue[] {
  if (authority.kind === 'session') {
    return [
      authority.orgId,
      authority.membershipId,
      authority.orgId,
      authority.userId,
      ...orgEpochParams(authority.orgUpdatedAt),
      authority.sessionId,
      now,
      now,
      JSON.stringify(rolesGranting(authority.capability)),
    ];
  }
  return [
    authority.orgId,
    authority.orgId,
    ...orgEpochParams(authority.orgUpdatedAt),
    authority.keyId,
    authority.keyOrgId,
    authority.mode,
    now,
    authority.scope,
  ];
}

/** The grant principal for a captured tenant authority (synchronous request: the session must be live). */
export function tenantPrincipal(authority: TenantPassWrite): Principal {
  return authority.kind === 'session'
    ? {
        kind: 'membership',
        membershipId: authority.membershipId,
        via: 'session',
        sessionIdHash: authority.sessionId,
        ...legacyRevision(authority.orgUpdatedAt),
        mode: authority.mode,
      }
    : {
        kind: 'api_key',
        keyId: authority.keyId,
        scope: authority.scope,
        ...legacyRevision(authority.orgUpdatedAt),
      };
}

/**
 * Grant checks that re-derive the capability (membership roles) or scope (key scopes) from the
 * principal's own immutable row, so a hand-built `TenantPassWrite` cannot claim more than it holds.
 */
export function capabilityChecks(authority: TenantPassWrite): Check[] {
  if (authority.kind === 'session')
    return [membershipCapability(authority.membershipId, authority.capability)];
  return [
    rawCheck(
      'actor',
      `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ?
        AND EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = ?))`,
      [authority.keyId, authority.scope],
    ),
  ];
}

/** The membership's own roles grant the capability. */
export function membershipCapability(membershipId: string, capability: OrgCapability): Check {
  return rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM org_memberships m WHERE m.id = ?
      AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value WHERE r.type = 'text'))`,
    [membershipId, JSON.stringify(rolesGranting(capability))],
  );
}

/** Platform-wide actions have no tenant membership, but still require a live admin session. */
export const platformAdminSessionSql = `EXISTS (
  SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id_hash = ?/* scan-ephemeral-session-id-hash */ AND s.user_id = ? AND u.status = 'active'
    AND s.revoked_at IS NULL AND s.expires_at > ? AND s.idle_expires_at > ?
    AND json_type(s.roles) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(s.roles) r WHERE r.type = 'text' AND r.value = 'admin')
)`;

export function platformAdminSessionParams(
  session: { sessionId: string; userId: string },
  now: number,
): SqlValue[] {
  return [session.sessionId, session.userId, now, now];
}

/** Check an authority snapshot outside a write; final writes must repeat the SQL predicate. */
export async function tenantPassAuthorityValid(
  db: D1Database,
  authority: TenantPassWrite,
  now: number,
): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok WHERE ${tenantPassAuthoritySql(authority)}`,
    tenantPassAuthorityParams(authority, now),
  );
  return row !== null;
}

/**
 * The org's `access_revision`. It moves only with the org status, so a branding or settings save
 * does not invalidate authority captured earlier. The name is kept for existing callers.
 */
export async function tenantOrgUpdatedAt(db: D1Database, orgId: string): Promise<number | null> {
  const row = await first<{ access_revision: number }>(
    db,
    "SELECT access_revision FROM orgs WHERE id = ? AND status = 'active'",
    [orgId],
  );
  return row?.access_revision ?? null;
}
