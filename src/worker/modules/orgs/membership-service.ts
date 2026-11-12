import {
  type InviteOrgMember,
  InviteOrgMemberSchema,
  type OrgInvitation,
  type OrgMember,
  type OrgMembership,
} from '../../../shared/contracts/org-membership.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import type { Check } from '../../platform/authority-checks.ts';
import type { Principal } from '../../platform/authority-principal.ts';
import { batch } from '../../platform/db.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  AppError,
  BadRequestError,
  ConflictError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import {
  membershipCapability,
  platformAdminSessionParams,
  platformAdminSessionSql,
} from '../passes/repo-authority.ts';
import { getOrgAccess, memberDto, parseRoles, requireOrgCapability } from './access.ts';
import { invitationEmail } from './invitation-email.ts';
import {
  insertInvitation,
  revokeActiveMembership,
  revokePendingInvitation,
} from './repo-member-writes.ts';
import * as repo from './repo-members.ts';

const TTL = 7 * 24 * 60 * 60 * 1000;
const invalidLink = () =>
  new BadRequestError('This invitation is invalid or expired.', 'INVITATION_INVALID');
const changed = () =>
  new ConflictError('The request could not be completed.', 'MEMBERSHIP_CONFLICT');
/** Platform-admin bypass, re-verified against the live admin session inside each statement. */
const adminFenceOf = (ctx: ServiceContext, auth: SessionAuth): repo.AdminFence =>
  auth.roles.includes('admin')
    ? {
        sql: `1 AND ${platformAdminSessionSql}`,
        params: platformAdminSessionParams(auth, ctx.clock.now()),
      }
    : { sql: '0', params: [] };
/**
 * Who manages the org for this request, as a grant principal: a platform admin whose session is live
 * (acting on this org while it is active), or a member holding `members:manage` with a live session.
 * The grant re-checks the principal inside the write; the capability is re-derived from the membership's
 * own roles.
 */
async function managerOf(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<{ principal: Principal; checks: Check[] }> {
  if (auth.roles.includes('admin') && (await repo.activePrincipal(ctx.env.DB, auth.userId, orgId)))
    return {
      principal: { kind: 'platform', userId: auth.userId, sessionIdHash: auth.sessionId, orgId },
      checks: [],
    };
  const membership = await requireOrgCapability(ctx, auth.userId, orgId, 'members:manage');
  return {
    principal: {
      kind: 'membership',
      membershipId: membership.id,
      via: 'session',
      sessionIdHash: auth.sessionId,
    },
    checks: [membershipCapability(membership.id, 'members:manage')],
  };
}
async function requireOrgManager(ctx: ServiceContext, auth: SessionAuth, orgId: string) {
  await managerOf(ctx, auth, orgId);
}
function invitationDto(row: repo.InvitationRow): OrgInvitation {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    roles: parseRoles(row.roles),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    acceptedAt: row.accepted_at,
  };
}
export async function listOrgMembers(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<OrgMember[]> {
  await requireOrgManager(ctx, auth, orgId);
  return (await repo.orgMembers(ctx.env.DB, orgId, auth.userId, adminFenceOf(ctx, auth))).map(
    memberDto,
  );
}
export async function listOrgInvitations(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<OrgInvitation[]> {
  await requireOrgManager(ctx, auth, orgId);
  return (await repo.orgInvitations(ctx.env.DB, orgId, auth.userId, adminFenceOf(ctx, auth))).map(
    invitationDto,
  );
}
export async function inviteOrgMember(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  input: InviteOrgMember,
): Promise<OrgInvitation> {
  const manager = await managerOf(ctx, auth, orgId);
  const parsed = InviteOrgMemberSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();
  const now = ctx.clock.now();
  const token = ctx.ids.token(32);
  const row = {
    id: ctx.ids.id(),
    orgId,
    email: parsed.data.email,
    roles: JSON.stringify(parsed.data.roles),
    hash: await sha256Hex(token),
    now,
    expires: now + TTL,
  };
  await insertInvitation(ctx, manager.principal, manager.checks, row, {
    orgId,
    actorType: 'user',
    actorId: auth.userId,
    action: 'org_invitation.create',
    targetType: 'org_invitation',
    targetId: row.id,
  });
  const link = `${baseUrl(ctx.env)}/api/v1/orgs/invitations/accept#${token}`;
  const org = await repo.orgName(ctx.env.DB, orgId);
  try {
    await createEmailBindingMailer(ctx.env).send({
      to: row.email,
      ...invitationEmail({ orgName: org?.name ?? 'an organization', link, base: baseUrl(ctx.env) }),
    });
  } catch {
    // Provider errors can contain message content, including the secret link, so none is logged.
    ctx.log.error('org_invitation.send_failed', { orgId, code: 'INVITATION_SEND_FAILED' });
    try {
      // Same manager grant as the invite: a revoked manager cannot clean up, and the failure is logged.
      await revokePendingInvitation(ctx, manager.principal, manager.checks, row.id, {
        orgId,
        actorType: 'user',
        actorId: auth.userId,
        action: 'org_invitation.revoke',
        targetType: 'org_invitation',
        targetId: row.id,
      });
    } catch (error) {
      ctx.log.error('org_invitation.compensation_failed', {
        orgId,
        code: 'INVITATION_COMPENSATION_FAILED',
        error,
      });
    }
    throw new UnavailableError('Unable to deliver the invitation.');
  }
  return {
    id: row.id,
    orgId,
    email: row.email,
    roles: parsed.data.roles,
    createdAt: now,
    expiresAt: row.expires,
    revokedAt: null,
    acceptedAt: null,
  };
}
/** The page shows which organization a link joins before anyone signs in; the token is the proof. */
export async function previewOrgInvitation(ctx: ServiceContext, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
  const row = await repo.invitationOrgName(ctx.env.DB, await sha256Hex(token));
  if (!row) throw invalidLink();
  return { orgName: row.name };
}
export async function revokeOrgInvitation(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  invitationId: string,
): Promise<void> {
  const manager = await managerOf(ctx, auth, orgId);
  const entry = {
    orgId,
    actorType: 'user' as const,
    actorId: auth.userId,
    action: 'org_invitation.revoke',
    targetType: 'org_invitation',
    targetId: invitationId,
  };
  if (!(await revokePendingInvitation(ctx, manager.principal, manager.checks, invitationId, entry)))
    throw changed();
}
export async function revokeOrgMembership(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  membershipId: string,
): Promise<void> {
  const manager = await managerOf(ctx, auth, orgId);
  let revoked: boolean;
  try {
    revoked = await revokeActiveMembership(ctx, manager.principal, manager.checks, membershipId, {
      orgId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'org_membership.revoke',
      targetType: 'org_membership',
      targetId: membershipId,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'LAST_ORG_ADMIN')
      throw new ConflictError(
        'This is the last org admin. Make someone else an org admin first.',
        'LAST_ORG_ADMIN',
      );
    throw error;
  }
  if (!revoked) throw changed();
}
export async function acceptOrgInvitation(
  ctx: ServiceContext,
  auth: SessionAuth,
  token: string,
): Promise<OrgMembership> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
  const hash = await sha256Hex(token);
  const invitation = await repo.invitationByHash(ctx.env.DB, hash);
  if (!invitation) throw invalidLink();
  try {
    parseRoles(invitation.roles);
  } catch {
    throw invalidLink();
  }
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const result = await batch(ctx.env.DB, [
    repo.acceptMembership(ctx.env.DB, id, hash, auth.userId, now),
    repo.consumeInvitation(ctx.env.DB, hash, now),
    repo.mutationAudit(
      ctx,
      invitation.org_id,
      auth.userId,
      'org_invitation.accept',
      'org_invitation',
      invitation.id,
    ),
    repo.mutationAudit(
      ctx,
      invitation.org_id,
      auth.userId,
      'org_membership.create',
      'org_membership',
      id,
    ),
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw invalidLink();
  const membership = await getOrgAccess(ctx, auth.userId, invitation.org_id);
  if (!membership || membership.id !== id) throw changed();
  return membership;
}
