import { first, run } from '../../platform/db.ts';

export function getAuthorFixtureMembership(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<{ id: string } | null> {
  return first<{ id: string }>(
    db,
    'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
    [orgId, userId],
  );
}

export async function insertAuthorFixtureMembership(
  db: D1Database,
  fixture: {
    orgId: string;
    userId: string;
    invitationId: string;
    membershipId: string;
    token: string;
    now: number;
  },
): Promise<void> {
  const { orgId, userId, invitationId, membershipId, token, now } = fixture;
  await run(
    db,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [
      invitationId,
      orgId,
      JSON.stringify(['template_author']),
      token,
      now,
      now + 3600_000,
      now,
      userId,
    ],
  );
  await run(
    db,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(['template_author']), now],
  );
}
