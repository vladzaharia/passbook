import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { first, run } from '../../platform/db.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';

export async function insertInboxMembership(
  kit: Kit,
  userId: string,
  orgId: string,
  role: OrgRole,
  invitationId: string,
  membershipId: string,
  token: string,
  now: number,
): Promise<void> {
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, JSON.stringify([role]), token, now, now + 3_600_000, now, userId],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify([role]), now],
  );
}

export function findInboxCapture(kit: Kit, outboxId: string) {
  return first<{ id: string; html: string; text: string }>(
    kit.env.DB,
    'SELECT id, html, text FROM captured_emails WHERE outbox_id = ?',
    [outboxId],
  );
}
