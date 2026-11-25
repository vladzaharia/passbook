import { all, first } from '../../platform/db.ts';
import { knownEmailSql } from '../../platform/known-email-sql.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';

export interface InvitationListRow {
  id: string;
  org_id: string;
  email: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  roles: string | null;
}

/** Pending invitations, plus those revoked or expired since `since`. Accepted ones are developers now. */
export const listableInvitations = (db: D1Database, orgId: string, now: number, since: number) =>
  all<InvitationListRow>(
    db,
    `SELECT d.id, d.org_id, d.email, d.created_at, d.expires_at, d.revoked_at, oi.roles
     FROM developer_invitations d LEFT JOIN org_invitations oi ON oi.id = d.org_invitation_id
     WHERE d.org_id = ? AND d.accepted_at IS NULL
       AND ((d.revoked_at IS NULL AND d.expires_at > ?) OR COALESCE(d.revoked_at, d.expires_at) > ?)
     ORDER BY d.created_at, d.id`,
    [orgId, now, since],
  );

export interface DeveloperListRow {
  user_id: string;
  since: number;
  name: string | null;
  email: string | null;
  roles: string | null;
}

/** Live sponsorships of the org with the person and the roles their invitation's membership holds. */
export const orgDevelopers = (db: D1Database, orgId: string) =>
  all<DeveloperListRow>(
    db,
    `SELECT s.user_id, s.created_at AS since, u.name, ${knownEmailSql('u.primary_email')} AS email,
       (SELECT m.roles FROM org_memberships m JOIN developer_invitations d ON d.org_invitation_id = m.invitation_id
         WHERE d.id = s.invitation_id AND m.org_id = s.org_id AND m.user_id = s.user_id AND m.revoked_at IS NULL) AS roles
     FROM developer_sponsors s JOIN users u ON u.id = s.user_id
     WHERE s.org_id = ? AND s.ended_at IS NULL AND u.status = 'active' ORDER BY s.created_at, s.id`,
    [orgId],
  );

/** The active membership that came from this developer invitation's paired org invitation. */
export const pairedMembershipId = async (
  db: D1Database,
  orgId: string,
  userId: string,
  invitationId: string,
): Promise<string | null> =>
  (
    await first<{ id: string }>(
      db,
      `SELECT m.id FROM org_memberships m JOIN developer_invitations d ON d.org_invitation_id = m.invitation_id
       WHERE d.id = ? AND m.org_id = ? AND m.user_id = ? AND m.revoked_at IS NULL`,
      [invitationId, orgId, userId],
    )
  )?.id ?? null;

/** The membership holds a role that administers the org (a key may not end it). */
export const pairedAdministers = async (db: D1Database, membershipId: string): Promise<boolean> => {
  const row = await first<{ roles: string }>(db, 'SELECT roles FROM org_memberships WHERE id = ?', [
    membershipId,
  ]);
  try {
    return (JSON.parse(row?.roles ?? '[]') as string[]).some((r) =>
      (ADMINISTERING_ROLES as readonly string[]).includes(r),
    );
  } catch {
    return true;
  }
};
