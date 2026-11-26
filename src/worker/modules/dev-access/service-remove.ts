import type { DeveloperList } from '../../../shared/contracts/developer-invitations.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { AppError, ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { revokeActiveMembership } from '../orgs/repo-member-writes.ts';
import { auditOf, devActorOf } from './authority.ts';
import { developerLimit, idpReady } from './availability.ts';
import { developerDto } from './dto.ts';
import { orgDevelopers, pairedAdministers, pairedMembershipId } from './repo-read.ts';
import { endSponsor, liveSponsorOf } from './repo-sponsors.ts';

export async function listDevelopers(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<DeveloperList> {
  await devActorOf(ctx, auth, orgId, 'members:read');
  const limit = await developerLimit(ctx, orgId);
  const available = (limit === null || limit > 0) && (await idpReady(ctx));
  const rows = available ? await orgDevelopers(ctx.env.DB, orgId) : [];
  return { available, limit, items: rows.map(developerDto), nextCursor: null };
}

/**
 * Ends this org's sponsorship of the person and revokes the membership their invitation made. Other
 * memberships stay, and so does the group until the settle run finds no live sponsorship. The answer
 * is the same whether or not they were sponsored here, so it never shows another org's sponsorship.
 */
export async function removeDeveloper(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  userId: string,
): Promise<void> {
  const actor = await devActorOf(ctx, auth, orgId, 'members:manage');
  const sponsor = await liveSponsorOf(ctx.env.DB, orgId, userId);
  if (!sponsor) return;
  const membershipId = await pairedMembershipId(ctx.env.DB, orgId, userId, sponsor.invitation_id);
  if (membershipId) {
    if (actor.actorType === 'api_key' && (await pairedAdministers(ctx.env.DB, membershipId)))
      throw new ForbiddenError(
        'Remove an org or integration admin from the console.',
        'DEVELOPER_INVITE_ROLE_NEEDS_SESSION',
      );
    try {
      await revokeActiveMembership(
        ctx,
        actor.principal,
        actor.checks,
        membershipId,
        auditOf(actor, orgId, 'org_membership.revoke', 'org_membership', membershipId),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'LAST_ORG_ADMIN')
        throw new ConflictError(
          'This is the last org admin. Make someone else an org admin first.',
          'LAST_ORG_ADMIN',
        );
      throw error;
    }
  }
  await endSponsor(
    ctx,
    actor.principal,
    actor.checks,
    sponsor.id,
    'removed',
    auditOf(actor, orgId, 'developer.remove', 'developer_sponsor', sponsor.id, {
      reason: 'removed',
    }),
  );
}
