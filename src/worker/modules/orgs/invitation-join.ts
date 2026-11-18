import { batch } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as repo from './repo-members.ts';

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
  const org = await repo.invitationOrgId(ctx.env.DB, invitationId);
  if (!org) return false;
  const result = await batch(ctx.env.DB, [
    repo.acceptMembershipById(ctx.env.DB, id, invitationId, userId, now),
    repo.consumeInvitationById(ctx.env.DB, invitationId, now),
    repo.mutationAudit(
      ctx,
      org.org_id,
      userId,
      'org_invitation.accept',
      'org_invitation',
      invitationId,
    ),
    repo.mutationAudit(ctx, org.org_id, userId, 'org_membership.create', 'org_membership', id),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
}
