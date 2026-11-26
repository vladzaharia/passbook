import type { InviteKind } from '../../../../shared/invitation-link.ts';
import { all, first } from '../../../platform/db.ts';

/** A member or developer invitation, read by its secret's hash. A developer one carries its paired member invitation. */
export interface InviteRow {
  kind: Exclude<InviteKind, 'platform'>;
  id: string;
  org_id: string;
  org_name: string;
  /** Developer sponsorship needs an active, standard, non-personal org; a membership needs an active one. */
  org_ok: number;
  email: string;
  expires_at: number;
  /** Developer invitations only: the end of the window to finish after a setup or a claim. */
  claim_until: number | null;
  revoked_at: number | null;
  accepted_at: number | null;
  /** The member invitation that makes the membership: the row itself, or the paired one; null for developer access alone. */
  member_id: string | null;
  member_hash: string | null;
  member_roles: string | null;
  member_revoked_at: number | null;
  member_accepted_at: number | null;
}

export const memberInvitationByHash = (db: D1Database, hash: string) =>
  first<InviteRow>(
    db,
    `SELECT 'member' AS kind, i.id, i.org_id, o.name AS org_name, (o.status = 'active') AS org_ok, i.email,
       i.expires_at, NULL AS claim_until, i.revoked_at, i.accepted_at,
       i.id AS member_id, i.token_hash AS member_hash, i.roles AS member_roles,
       i.revoked_at AS member_revoked_at, i.accepted_at AS member_accepted_at
     FROM org_invitations i JOIN orgs o ON o.id = i.org_id WHERE i.token_hash = ?`,
    [hash],
  );

export const developerInvitationByHash = (db: D1Database, hash: string) =>
  first<InviteRow>(
    db,
    `SELECT 'developer' AS kind, d.id, d.org_id, o.name AS org_name,
       (o.status = 'active' AND o.kind = 'standard' AND o.personal_user_id IS NULL) AS org_ok, d.email,
       d.expires_at, d.claim_until, d.revoked_at, d.accepted_at,
       m.id AS member_id, m.token_hash AS member_hash, m.roles AS member_roles,
       m.revoked_at AS member_revoked_at, m.accepted_at AS member_accepted_at
     FROM developer_invitations d JOIN orgs o ON o.id = d.org_id
     LEFT JOIN org_invitations m ON m.id = d.org_invitation_id WHERE d.token_hash = ?`,
    [hash],
  );

export interface SetupRow {
  idp_token_id: string;
  created_at: number;
  expires_at: number;
}

/** Signup tokens minted for the invitation, oldest first. Ids only: the tokens are never stored. */
export const setupsOf = (db: D1Database, kind: InviteRow['kind'], invitationId: string) =>
  all<SetupRow>(
    db,
    kind === 'member'
      ? 'SELECT idp_token_id, created_at, expires_at FROM org_invitation_setups WHERE invitation_id = ? ORDER BY created_at, idp_token_id'
      : 'SELECT idp_token_id, created_at, expires_at FROM developer_invite_setups WHERE invitation_id = ? ORDER BY created_at, idp_token_id',
    [invitationId],
  );

/** The account holds this address, verified: the same join the legacy accept used. */
export async function hasEmail(db: D1Database, userId: string, email: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    "SELECT 1 AS ok FROM users u JOIN user_emails e ON e.user_id = u.id WHERE u.id = ? AND u.status = 'active' AND e.email = ?",
    [userId, email],
  );
  return row !== null;
}

/** An accepted invitation's person, for a replay by the same user. */
export const acceptedBy = (db: D1Database, kind: InviteRow['kind'], id: string) =>
  first<{ user_id: string; membership_id: string | null }>(
    db,
    kind === 'developer'
      ? `SELECT d.accepted_user_id AS user_id,
           (SELECT m.id FROM org_memberships m WHERE m.invitation_id = d.org_invitation_id AND m.user_id = d.accepted_user_id) AS membership_id
         FROM developer_invitations d WHERE d.id = ? AND d.accepted_at IS NOT NULL`
      : `SELECT m.user_id, m.id AS membership_id FROM org_memberships m WHERE m.invitation_id = ?`,
    [id],
  );

/** The developer invitation a member invitation is paired with, when it has one. */
export async function pairedDeveloperOf(
  db: D1Database,
  memberInvitationId: string,
): Promise<string | null> {
  const row = await first<{ id: string }>(
    db,
    'SELECT id FROM developer_invitations WHERE org_invitation_id = ?',
    [memberInvitationId],
  );
  return row?.id ?? null;
}
