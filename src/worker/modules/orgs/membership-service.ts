import {
  type InviteOrgMember,
  InviteOrgMemberSchema,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
} from '../../../shared/contracts/org-membership.ts';
import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';
import { INVITE_PATH, INVITE_PREFIX } from '../../../shared/invitation-link.ts';
import type { Actor } from '../../platform/actor.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { resolveInvite } from '../idp/invitations/resolve.ts';
import { withdrawForMember } from '../idp/invitations/withdraw.ts';
import { platformAdminSessionParams, platformAdminSessionSql } from '../passes/repo-authority.ts';
import { memberDto, parseRoles } from './access.ts';
import { auditOf, keyRoleGuard, orgActorOf } from './actor.ts';
import { invitationEmail } from './invitation-email.ts';
import { checkInviteAllowed } from './invitation-limits.ts';
import {
  insertInvitation,
  membersLimit,
  revokeActiveMembership,
  revokePendingInvitation,
} from './repo-member-writes.ts';
import * as repo from './repo-members.ts';
import { isPersonalOrg } from './repo-personal.ts';

export const INVITATION_TTL = 7 * 24 * 60 * 60 * 1000;
const invalidLink = () =>
  new BadRequestError('This invitation is invalid or expired.', 'INVITATION_INVALID');
/** Roles as stored; a value that does not parse counts as administering, so a key never acts on it. */
export function storedRoles(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.map(String) : [...ADMINISTERING_ROLES];
  } catch {
    return [...ADMINISTERING_ROLES];
  }
}
export const changed = () =>
  new ConflictError('The request could not be completed.', 'MEMBERSHIP_CONFLICT');
/** A personal org has one member, its owner: nobody is invited and the owner is never revoked. */
export async function assertNotPersonal(ctx: ServiceContext, orgId: string): Promise<void> {
  if (await isPersonalOrg(ctx.env.DB, orgId))
    throw new ConflictError(PERSONAL_ORG_COPY.singleMember, 'ORG_PERSONAL_SINGLE_MEMBER');
}
/** Platform-admin bypass, re-verified against the live admin session inside each statement; a key has none. */
export const adminFenceOf = (ctx: ServiceContext, auth: AuthContext): repo.AdminFence =>
  auth.kind === 'session' && auth.roles.includes('admin')
    ? {
        sql: `1 AND ${platformAdminSessionSql}`,
        params: platformAdminSessionParams(auth, ctx.clock.now()),
      }
    : { sql: '0', params: [] };
/** Whether the caller manages the org; anything but a refusal still throws. */
export async function isOrgManager(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<boolean> {
  try {
    await orgActorOf(ctx, auth, orgId, 'members:read');
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
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
  auth: AuthContext,
  orgId: string,
): Promise<OrgMember[]> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:read');
  const rows =
    actor.userId === null
      ? await repo.keyOrgMembers(ctx.env.DB, orgId, actor.principal, actor.checks, ctx.clock.now())
      : await repo.orgMembers(ctx.env.DB, orgId, actor.userId, adminFenceOf(ctx, auth));
  return rows.map(memberDto);
}
export async function listOrgInvitations(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<OrgInvitation[]> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:read');
  const rows =
    actor.userId === null
      ? await repo.keyOrgInvitations(
          ctx.env.DB,
          orgId,
          actor.principal,
          actor.checks,
          ctx.clock.now(),
        )
      : await repo.orgInvitations(ctx.env.DB, orgId, actor.userId, adminFenceOf(ctx, auth));
  return rows.map(invitationDto);
}
/** Who a mail names: the person, or the organization for its key. */
async function senderName(
  ctx: ServiceContext,
  actor: Actor,
  orgName?: string,
): Promise<string | null> {
  if (actor.sender.kind === 'person') return repo.userName(ctx.env.DB, actor.sender.userId);
  return actor.sender.kind === 'org' ? (orgName ?? null) : 'PassBook';
}
/** Mails the accept link; when the mail cannot go, the invitation is revoked again and the request fails. */
export async function deliverInvitation(
  ctx: ServiceContext,
  actor: Actor,
  orgId: string,
  id: string,
  email: string,
  roles: OrgRole[],
  token: string,
): Promise<void> {
  const acceptLink = `${baseUrl(ctx.env)}${INVITE_PATH}#${token}`;
  const org = await repo.orgName(ctx.env.DB, orgId);
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  try {
    await createEmailBindingMailer(ctx.env).send({
      to: email,
      ...invitationEmail({
        orgName: org?.name ?? 'an organization',
        roles: roles,
        inviter: await senderName(ctx, actor, org?.name),
        link: acceptLink,
        base: baseUrl(ctx.env),
      }),
    });
  } catch {
    // Provider errors can contain message content, including the secret link, so none is logged.
    ctx.log.error('org_invitation.send_failed', { orgId, code: 'INVITATION_SEND_FAILED' });
    try {
      // Same actor grant as the invite: a revoked manager cannot clean up, and the failure is logged.
      await revokePendingInvitation(
        ctx,
        actor.principal,
        actor.checks,
        id,
        auditOf(actor, orgId, 'org_invitation.revoke', 'org_invitation', id),
      );
    } catch (error) {
      ctx.log.error('org_invitation.compensation_failed', {
        orgId,
        code: 'INVITATION_COMPENSATION_FAILED',
        error,
      });
    }
    throw new UnavailableError('Unable to deliver the invitation.');
  }
}
export async function inviteOrgMember(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  input: InviteOrgMember,
): Promise<OrgInvitation> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:manage');
  await assertNotPersonal(ctx, orgId);
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  const parsed = InviteOrgMemberSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();
  keyRoleGuard(actor, parsed.data.roles);
  await checkInviteAllowed(ctx, { actorId: actor.rateKey, orgId, email: parsed.data.email });
  const now = ctx.clock.now();
  const token = `${INVITE_PREFIX.member}${ctx.ids.token(32)}`;
  const row = {
    id: ctx.ids.id(),
    orgId,
    email: parsed.data.email,
    roles: JSON.stringify(parsed.data.roles),
    hash: await sha256Hex(token),
    now,
    expires: now + INVITATION_TTL,
  };
  await insertInvitation(
    ctx,
    actor.principal,
    [...actor.checks, membersLimit(now)],
    row,
    auditOf(actor, orgId, 'org_invitation.create', 'org_invitation', row.id),
  );
  await deliverInvitation(ctx, actor, orgId, row.id, row.email, parsed.data.roles, token);
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
/** The pre-prefix preview: which organization a member link joins. The invitation page's preview says more. */
export async function previewOrgInvitation(ctx: ServiceContext, token: string) {
  const invite = await resolveInvite(ctx, token);
  if (invite?.kind !== 'member' || invite.state !== 'pending') throw invalidLink();
  return { orgName: invite.row.org_name };
}
export async function revokeOrgInvitation(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  invitationId: string,
): Promise<void> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:manage');
  const entry = auditOf(actor, orgId, 'org_invitation.revoke', 'org_invitation', invitationId);
  if (!(await revokePendingInvitation(ctx, actor.principal, actor.checks, invitationId, entry)))
    throw changed();
  await withdrawForMember(ctx, invitationId);
}
export async function revokeOrgMembership(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  membershipId: string,
): Promise<void> {
  const actor = await orgActorOf(ctx, auth, orgId, 'members:manage');
  await assertNotPersonal(ctx, orgId);
  if (actor.keyId !== null) {
    const current = await repo.activeMembershipById(ctx.env.DB, orgId, membershipId);
    if (current) keyRoleGuard(actor, storedRoles(current.roles));
  }
  let revoked: boolean;
  try {
    revoked = await revokeActiveMembership(
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
  if (!revoked) throw changed();
}
