import { all, first, type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';

export interface MembershipRow {
  id: string;
  org_id: string;
  org_name: string;
  org_slug: string;
  user_id: string;
  user_name: string | null;
  user_email: string;
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
const membershipSelect = `SELECT m.*, o.name AS org_name, o.slug AS org_slug, u.name AS user_name, u.primary_email AS user_email FROM org_memberships m
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
  typeof admin === 'boolean' ? (admin ? { sql: '? = 1', params: [1] } : noAdmin) : admin;
// Repeat the manager authorization predicate at the read or mutation itself.
const managerSql = (admin: AdminFence) => `EXISTS (SELECT 1 FROM users u JOIN orgs o ON o.id = ?
 WHERE u.id = ? AND u.status = 'active' AND o.status = 'active' AND
 ((${admin.sql}) OR EXISTS (SELECT 1 FROM org_memberships m, json_each(m.roles) r
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
export function orgMembers(
  db: D1Database,
  orgId: string,
  userId: string,
  admin: AdminFence | boolean,
) {
  const m = manager(orgId, userId, admin);
  return all<MembershipRow>(
    db,
    `${membershipSelect} WHERE m.org_id = ? AND m.revoked_at IS NULL AND o.status = 'active' AND u.status = 'active' AND ${m.sql} ORDER BY m.created_at, m.id`,
    [orgId, ...m.params],
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
export function invitationByHash(db: D1Database, hash: string) {
  return first<InvitationRow>(
    db,
    'SELECT id, org_id, email, roles, created_at, expires_at, revoked_at, accepted_at FROM org_invitations WHERE token_hash = ?',
    [hash],
  );
}
export function invitationOrgName(db: D1Database, hash: string) {
  return first<{ name: string }>(
    db,
    `SELECT o.name FROM org_invitations i JOIN orgs o ON o.id = i.org_id
 WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND o.status = 'active'`,
    [hash],
  );
}
export function orgName(db: D1Database, orgId: string) {
  return first<{ name: string }>(db, 'SELECT name FROM orgs WHERE id = ?', [orgId]);
}
export function activePrincipal(db: D1Database, userId: string, orgId: string) {
  return first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM users u JOIN orgs o ON o.id = ? WHERE u.id = ? AND u.status = 'active' AND o.status = 'active'`,
    [orgId, userId],
  );
}
const holdsOrgAdmin = (alias: string) =>
  `EXISTS (SELECT 1 FROM json_each(${alias}.roles) ar WHERE ar.value = 'org_admin')`;
const otherAdmin = `SELECT 1 FROM org_memberships o2 JOIN users u2 ON u2.id = o2.user_id
 WHERE o2.org_id = ? AND o2.id != ? AND o2.revoked_at IS NULL AND u2.status = 'active' AND ${holdsOrgAdmin('o2')}`;
export function revokeMembership(
  db: D1Database,
  orgId: string,
  id: string,
  now: number,
  userId: string,
  admin: AdminFence | boolean,
) {
  const m = manager(orgId, userId, admin);
  return stmt(
    db,
    `UPDATE org_memberships SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL
 AND (NOT ${holdsOrgAdmin('org_memberships')} OR EXISTS (${otherAdmin})) AND ${m.sql}`,
    [now, id, orgId, orgId, id, ...m.params],
  );
}
export function acceptMembership(
  db: D1Database,
  id: string,
  hash: string,
  userId: string,
  now: number,
) {
  return stmt(
    db,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
 SELECT ?, i.org_id, u.id, i.id, i.roles, ? FROM org_invitations i
 JOIN orgs o ON o.id = i.org_id AND o.status = 'active'
 JOIN users u ON u.id = ? AND u.status = 'active'
 JOIN user_emails e ON e.user_id = u.id AND e.email = i.email
 WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > ?
 AND NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = i.org_id AND m.user_id = u.id AND m.revoked_at IS NULL)`,
    [id, now, userId, hash, now],
  );
}
export function consumeInvitation(db: D1Database, hash: string, now: number) {
  return stmt(
    db,
    'UPDATE org_invitations SET accepted_at = ? WHERE token_hash = ? AND changes() = 1',
    [now, hash],
  );
}
export function mutationAudit(
  ctx: ServiceContext,
  orgId: string,
  userId: string,
  action: string,
  targetType: string,
  targetId: string,
) {
  return stmt(
    ctx.env.DB,
    `INSERT INTO audit_log (at, org_id, actor_type, actor_id, action, target_type, target_id, request_id, ip_prefix, detail)
 SELECT ?, ?, 'user', ?, ?, ?, ?, ?, NULL, NULL WHERE changes() = 1`,
    [ctx.clock.now(), orgId, userId, action, targetType, targetId, ctx.requestId],
  );
}
