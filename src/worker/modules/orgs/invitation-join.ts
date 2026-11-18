import { batch, first, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { mutationAudit } from './repo-members.ts';

/**
 * Joins `userId` to the org of a pending invitation by its id, after a sign-in link bound to that
 * invitation proved the address. The address must be on the account, as in a token accept.
 */
export async function joinByInvitation(
  ctx: ServiceContext,
  userId: string,
  invitationId: string,
): Promise<boolean> {
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const org = await first<{ org_id: string }>(
    ctx.env.DB,
    'SELECT org_id FROM org_invitations WHERE id = ?',
    [invitationId],
  );
  if (!org) return false;
  const result = await batch(ctx.env.DB, [
    stmt(
      ctx.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
 SELECT ?, i.org_id, u.id, i.id, i.roles, ? FROM org_invitations i
 JOIN orgs o ON o.id = i.org_id AND o.status = 'active'
 JOIN users u ON u.id = ? AND u.status = 'active'
 JOIN user_emails e ON e.user_id = u.id AND e.email = i.email
 WHERE i.id = ? AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > ?
 AND NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = i.org_id AND m.user_id = u.id AND m.revoked_at IS NULL)`,
      [id, now, userId, invitationId, now],
    ),
    stmt(ctx.env.DB, 'UPDATE org_invitations SET accepted_at = ? WHERE id = ? AND changes() = 1', [
      now,
      invitationId,
    ]),
    mutationAudit(ctx, org.org_id, userId, 'org_invitation.accept', 'org_invitation', invitationId),
    mutationAudit(ctx, org.org_id, userId, 'org_membership.create', 'org_membership', id),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
}
