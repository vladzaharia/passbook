import type {
  OrgInvitation,
  OrgMember,
  OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { memberDto, parseRoles } from './access.ts';
import { checkInviteAllowed } from './invitation-limits.ts';
import {
  adminFenceOf,
  assertNotPersonal,
  changed,
  deliverInvitation,
  INVITATION_TTL,
  managerOf,
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
  auth: SessionAuth,
  orgId: string,
  invitationId: string,
): Promise<OrgInvitation> {
  const manager = await managerOf(ctx, auth, orgId);
  await assertNotPersonal(ctx, orgId);
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  const old = await repo.invitationById(ctx.env.DB, orgId, invitationId);
  if (!old || old.revoked_at !== null || old.accepted_at !== null) throw changed();
  const now = ctx.clock.now();
  await checkInviteAllowed(ctx, { actorId: auth.userId, orgId, email: old.email }, true);
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
  const checks = old.expires_at <= now ? [...manager.checks, membersLimit(now)] : manager.checks;
  await replaceInvitation(ctx, manager.principal, checks, old.id, row, {
    orgId,
    actorType: 'user',
    actorId: auth.userId,
    action: 'org_invitation.resend',
    targetType: 'org_invitation',
    targetId: row.id,
    detail: { replaces: old.id },
  });
  await deliverInvitation(ctx, auth, manager, orgId, row.id, row.email, roles, token);
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
  auth: SessionAuth,
  orgId: string,
  membershipId: string,
  roles: OrgRole[],
): Promise<OrgMember> {
  const manager = await managerOf(ctx, auth, orgId);
  await assertNotPersonal(ctx, orgId);
  const current = await repo.activeMembershipById(ctx.env.DB, orgId, membershipId);
  if (!current) throw new NotFoundError('Member not found.', 'MEMBERSHIP_NOT_FOUND');
  const fence = adminFenceOf(ctx, auth);
  const listed = async (userId: string) => {
    const rows = await repo.orgMembers(ctx.env.DB, orgId, auth.userId, fence);
    const row = rows.find((r) => r.user_id === userId);
    if (!row) throw changed();
    return memberDto(row);
  };
  const before = parseRoles(current.roles);
  if (before.length === roles.length && before.every((role) => roles.includes(role)))
    return listed(current.user_id);
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
  };
  const losesAdmin = before.includes('org_admin') && !roles.includes('org_admin');
  try {
    await replaceMembership(
      ctx,
      manager.principal,
      losesAdmin ? [...manager.checks, notLastOrgAdmin(current.id)] : manager.checks,
      next,
      {
        orgId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'org_membership.roles',
        targetType: 'org_membership',
        targetId: next.membershipId,
        detail: { replaces: current.id, from: before, to: roles },
      },
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
  return listed(current.user_id);
}
