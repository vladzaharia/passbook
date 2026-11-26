import type {
  OrgInvitation,
  OrgMember,
  OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { memberDto, parseRoles } from './access.ts';
import { auditOf, keyRoleGuard, orgActorOf } from './actor.ts';
import { checkInviteAllowed } from './invitation-limits.ts';
import {
  assertNotPersonal,
  changed,
  deliverInvitation,
  INVITATION_TTL,
  storedRoles,
} from './membership-service.ts';
import { replaceInvitation, replaceMembership } from './repo-member-replace.ts';
import { membersLimit, notLastOrgAdmin } from './repo-member-writes.ts';
import * as repo from './repo-members.ts';

/**
 * A fresh link and a new seven days for a pending invitation, mailed again. The old row is revoked
 * and its successor written in one batch (invitations are immutable), so the old link stops working
 * and the answer carries the new invitation's id.
 */
export async function resendOrgInvitation(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  invitationId: string,
): Promise<OrgInvitation> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:manage');
  await assertNotPersonal(ctx, orgId);
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  const old = await repo.invitationById(ctx.env.DB, orgId, invitationId);
  if (!old || old.revoked_at !== null || old.accepted_at !== null) throw changed();
  const now = ctx.clock.now();
  keyRoleGuard(actor, storedRoles(old.roles));
  await checkInviteAllowed(ctx, { actorId: actor.rateKey, orgId, email: old.email }, true);
  const roles = parseRoles(old.roles);
  const token = ctx.ids.token(32);
  const row = {
    id: ctx.ids.id(),
    email: old.email,
    roles: old.roles,
    hash: await sha256Hex(token),
    now,
    expires: now + INVITATION_TTL,
  };
  // An expired invitation was not counted against the members limit; its successor is.
  const checks = old.expires_at <= now ? [...actor.checks, membersLimit(now)] : actor.checks;
  await replaceInvitation(
    ctx,
    actor.principal,
    checks,
    old.id,
    row,
    auditOf(actor, orgId, 'org_invitation.resend', 'org_invitation', row.id, { replaces: old.id }),
  );
  await deliverInvitation(ctx, actor, orgId, row.id, row.email, roles, token);
  return {
    id: row.id,
    orgId,
    email: row.email,
    roles,
    createdAt: now,
    expiresAt: row.expires,
    revokedAt: null,
    acceptedAt: null,
  };
}

/**
 * Replaces the member's roles. Memberships are immutable, so the old one is revoked and a new one
 * written in the same batch; the old membership's keys and grants end with it. Taking the last
 * org admin's admin role away is refused (`LAST_ORG_ADMIN`).
 */
export async function changeOrgMemberRoles(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  membershipId: string,
  roles: OrgRole[],
): Promise<OrgMember> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:manage');
  await assertNotPersonal(ctx, orgId);
  keyRoleGuard(actor, roles);
  const current = await repo.activeMembershipById(ctx.env.DB, orgId, membershipId);
  if (!current) throw new NotFoundError('Member not found.', 'MEMBERSHIP_NOT_FOUND');
  const answer = async (id: string) => {
    const row = await repo.memberRowById(ctx.env.DB, orgId, id);
    if (!row) throw changed();
    return memberDto(row);
  };
  const before = parseRoles(current.roles);
  keyRoleGuard(actor, before);
  if (before.length === roles.length && before.every((role) => roles.includes(role)))
    return answer(current.id);
  const now = ctx.clock.now();
  const next = {
    oldId: current.id,
    userId: current.user_id,
    email: current.email,
    roles: JSON.stringify(roles),
    membershipId: ctx.ids.id(),
    invitationId: ctx.ids.id(),
    hash: await sha256Hex(ctx.ids.token(32)),
    now,
    joinedAt: current.joined_at,
  };
  const losesAdmin = before.includes('org_admin') && !roles.includes('org_admin');
  try {
    await replaceMembership(
      ctx,
      actor.principal,
      losesAdmin ? [...actor.checks, notLastOrgAdmin(current.id)] : actor.checks,
      next,
      auditOf(actor, orgId, 'org_membership.roles', 'org_membership', next.membershipId, {
        replaces: current.id,
        from: before,
        to: roles,
      }),
      { config: 'LAST_ORG_ADMIN' },
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'LAST_ORG_ADMIN')
      throw new ConflictError(
        'This is the last org admin. Make someone else an org admin first.',
        'LAST_ORG_ADMIN',
      );
    throw error;
  }
  return answer(next.membershipId);
}
