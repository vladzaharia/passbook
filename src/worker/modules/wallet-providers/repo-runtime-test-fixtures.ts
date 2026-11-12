import { run } from '../../platform/db.ts';

export function insertRuntimeFixtureInvitation(
  db: D1Database,
  input: { id: string; orgId: string; email: string; tokenHash: string; now: number },
) {
  return run(
    db,
    `INSERT INTO org_invitations
    (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.orgId,
      input.email,
      '["org_admin"]',
      input.tokenHash,
      input.now,
      input.now + 3_600_000,
      input.now,
    ],
  );
}

export function insertRuntimeFixtureMembership(
  db: D1Database,
  input: { id: string; orgId: string; userId: string; invitationId: string; now: number },
) {
  return run(
    db,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [input.id, input.orgId, input.userId, input.invitationId, '["org_admin"]', input.now],
  );
}
