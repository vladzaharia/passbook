import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { authorityPredicate } from '../../platform/authority-read.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';

export interface MembershipRow {
  id: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  personal_user_id: string | null;
  org_kind: string;
  user_id: string;
  user_name: string | null;
  /** Null for an account whose primary email is the no-verified-email placeholder. */
  user_email: string | null;
  roles: string;
  created_at: number;
  revoked_at: number | null;
}
export interface InvitationRow {
  id: string;
  org_id: string;
  email: string;
  roles: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  accepted_at: number | null;
}
const membershipSelect = `SELECT m.*, o.name AS org_name, o.slug AS org_slug, o.personal_user_id, o.kind AS org_kind, u.name AS user_name, ${knownEmailSql('u.primary_email')} AS user_email FROM org_memberships m
 JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id`;
/**
 * SQL for "this principal may bypass membership as a platform admin". The service passes
 * platformAdminSessionSql (passes/repo-authority.ts); it cannot be imported here without a cycle.
 * A bare boolean is accepted for callers with no session to re-verify and grants nothing extra.
 */
export interface AdminFence {
  sql: string;
  params: SqlValue[];
}
const noAdmin: AdminFence = { sql: '0', params: [] };
const adminFence = (admin: AdminFence | boolean): AdminFence =>
  typeof admin === 'boolean' ? (admin ? { sql: '1', params: [] } : noAdmin) : admin;
// Repeat the manager authorization predicate at the read or mutation itself.
const managerSql = (admin: AdminFence) => `EXISTS (SELECT 1 FROM users u JOIN orgs o ON o.id = ?
 WHERE u.id = ? AND u.status = 'active' AND o.status = 'active' AND
 ((o.personal_user_id IS NULL AND (${admin.sql})) OR EXISTS (SELECT 1 FROM org_memberships m, json_each(m.roles) r
 WHERE m.org_id = o.id AND m.user_id = u.id AND m.revoked_at IS NULL AND r.value = 'org_admin'
 AND NOT EXISTS (SELECT 1 FROM json_each(m.roles) x WHERE x.type != 'text' OR x.value NOT IN ('org_admin','integration_admin','template_author','template_reviewer','template_publisher','pass_operator','read_only'))
 AND (SELECT count(*) FROM json_each(m.roles)) = (SELECT count(DISTINCT value) FROM json_each(m.roles))))) `;
/** SQL plus its parameters, in order: org, user, then the admin fence. */
const manager = (orgId: string, userId: string, admin: AdminFence | boolean) => {
  const fence = adminFence(admin);
  return { sql: managerSql(fence), params: [orgId, userId, ...fence.params] as SqlValue[] };
};
export function activeMembership(db: D1Database, userId: string, orgId: string) {
  return first<MembershipRow>(
    db,
    `${membershipSelect} WHERE m.user_id = ? AND m.org_id = ? AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active'`,
    [userId, orgId],
  );
}
export function myMemberships(db: D1Database, userId: string) {
  return all<MembershipRow>(
    db,
    `${membershipSelect} WHERE m.user_id = ? AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active' ORDER BY m.created_at, m.id`,
    [userId],
  );
}
/**
 * The org's members. `user_email` is the email the org invited them by; only a platform administrator
 * (the admin fence) sees the account's primary email, which may belong to another org's member.
 */
export function orgMembers(
  db: D1Database,
  orgId: string,
  userId: string,
  admin: AdminFence | boolean,
) {
  const m = manager(orgId, userId, admin);
  const f = adminFence(admin);
  return all<MembershipRow>(
    db,
    `SELECT m.*, o.name AS org_name, o.slug AS org_slug, o.personal_user_id, o.kind AS org_kind, u.name AS user_name,
       CASE WHEN (${f.sql}) THEN ${knownEmailSql('u.primary_email')}
         ELSE COALESCE((SELECT i.email FROM org_invitations i WHERE i.id = m.invitation_id), 'Account') END AS user_email
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active' AND ${m.sql} ORDER BY m.created_at, m.id`,
    [...f.params, orgId, ...m.params],
  );
}
export function orgInvitations(
  db: D1Database,
  orgId: string,
  userId: string,
  admin: AdminFence | boolean,
) {
  const m = manager(orgId, userId, admin);
  return all<InvitationRow>(
    db,
    `SELECT id, org_id, email, roles, created_at, expires_at, revoked_at, accepted_at FROM org_invitations WHERE org_id = ? AND ${m.sql} ORDER BY created_at, id`,
    [orgId, ...m.params],
  );
}
/** An active membership of the org with the address it was invited by (kept on a role change). */
export function activeMembershipById(db: D1Database, orgId: string, id: string) {
  return first<{
    id: string;
    user_id: string;
    invitation_id: string;
    roles: string;
    joined_at: number;
    email: string;
  }>(
    db,
    `SELECT m.id, m.user_id, m.invitation_id, m.roles, COALESCE(m.joined_at, m.created_at) AS joined_at, i.email FROM org_memberships m
 JOIN org_invitations i ON i.id = m.invitation_id
 WHERE m.org_id = ? AND m.id = ? AND m.revoked_at IS NULL`,
    [orgId, id],
  );
}
/**
 * One membership of the org, active or not, as the member list shows it (the address it was invited
 * by). No manager fence: the caller just wrote the row, and a manager who demoted themselves, or a
 * target who is suspended, still has the answer to what they did.
 */
export function memberRowById(db: D1Database, orgId: string, id: string) {
  return first<MembershipRow>(
    db,
    `SELECT m.*, o.name AS org_name, o.slug AS org_slug, o.personal_user_id, o.kind AS org_kind, u.name AS user_name,
       COALESCE((SELECT i.email FROM org_invitations i WHERE i.id = m.invitation_id), 'Account') AS user_email
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND m.id = ?`,
    [orgId, id],
  );
}
export function invitationById(db: D1Database, orgId: string, id: string) {
  return first<InvitationRow>(
    db,
    'SELECT id, org_id, email, roles, created_at, expires_at, revoked_at, accepted_at FROM org_invitations WHERE org_id = ? AND id = ?',
    [orgId, id],
  );
}
/** The name a person gave, or null: an invitation names its sender only by that, never an address. */
export async function userName(db: D1Database, userId: string): Promise<string | null> {
  const row = await first<{ name: string | null }>(db, 'SELECT name FROM users WHERE id = ?', [
    userId,
  ]);
  return row?.name?.trim() || null;
}
export function orgName(db: D1Database, orgId: string) {
  return first<{ name: string }>(db, 'SELECT name FROM orgs WHERE id = ?', [orgId]);
}
/** A platform admin acts on a live org that is not personal (a personal org's members are its owner's to manage). */
export function activePrincipal(db: D1Database, userId: string, orgId: string) {
  return first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM users u JOIN orgs o ON o.id = ? WHERE u.id = ? AND u.status = 'active' AND o.status = 'active' AND o.personal_user_id IS NULL`,
    [orgId, userId],
  );
}
export function pendingInvitationFor(db: D1Database, orgId: string, email: string, now: number) {
  return first<{ found: number }>(
    db,
    `SELECT 1 AS found FROM org_invitations
     WHERE org_id = ? AND email = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?`,
    [orgId, email, now],
  );
}

/** A key's read of its own org: the grant's actor checks, re-run inside the query, name the org (never the request). */
const keyReadGuard = (principal: Principal, checks: Check[], now: number) => {
  const { ctes, params } = authorityPredicate(principal, { scope: 'org', now, checks });
  return { head: `WITH ${ctes}`, params, sql: 'm.org_id = (SELECT org_id FROM actor_ok)' };
};
/** The org's members for a key: the invitation's address, never an account's primary email. */
export function keyOrgMembers(
  db: D1Database,
  orgId: string,
  principal: Principal,
  checks: Check[],
  now: number,
) {
  const g = keyReadGuard(principal, checks, now);
  return all<MembershipRow>(
    db,
    `${g.head} SELECT m.*, o.name AS org_name, o.slug AS org_slug, o.personal_user_id, o.kind AS org_kind, u.name AS user_name,
       COALESCE((SELECT i.email FROM org_invitations i WHERE i.id = m.invitation_id), 'Account') AS user_email
     FROM org_memberships m JOIN orgs o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ? AND ${g.sql} AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active'
     ORDER BY m.created_at, m.id`,
    [...g.params, orgId],
  );
}
export function keyOrgInvitations(
  db: D1Database,
  orgId: string,
  principal: Principal,
  checks: Check[],
  now: number,
) {
  const g = keyReadGuard(principal, checks, now);
  return all<InvitationRow>(
    db,
    `${g.head} SELECT m.id, m.org_id, m.email, m.roles, m.created_at, m.expires_at, m.revoked_at, m.accepted_at
     FROM org_invitations m WHERE m.org_id = ? AND ${g.sql} ORDER BY m.created_at, m.id`,
    [...g.params, orgId],
  );
}
