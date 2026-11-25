import {
  type DeveloperInvitation,
  type InviteDeveloper,
  InviteDeveloperSchema,
} from '../../../shared/contracts/developer-invitations.ts';
import { PERSONAL_ORG_COPY } from '../../../shared/copy/personal-org.ts';
import { INVITE_PATH, INVITE_PREFIX } from '../../../shared/invitation-link.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ADMINISTERING_ROLES } from '../../platform/org-role-grants.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createEmailBindingMailer } from '../delivery/mailer.ts';
import { assertNotPreviewOnly } from '../developer/fence.ts';
import { membersLimit } from '../orgs/repo-member-writes.ts';
import * as members from '../orgs/repo-members.ts';
import { isPersonalOrg } from '../orgs/repo-personal.ts';
import { auditOf, type DevActor, devActorOf } from './authority.ts';
import { assertIdpReady } from './availability.ts';
import { invitationDto } from './dto.ts';
import { developerInvitationEmail } from './invitation-email.ts';
import { checkDeveloperInviteAllowed } from './limits.ts';
import {
  insertDeveloperInvitation,
  invitationById,
  revokeDeveloperInvitation as revokeRows,
} from './repo.ts';
import { developersLimit } from './repo-limits.ts';
import { listableInvitations } from './repo-read.ts';

const TTL = 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const LISTED_FOR = 30 * DAY;

/** Personal orgs have one member and sandboxes are Test only: neither vouches for developers. */
async function assertCanSponsor(ctx: ServiceContext, orgId: string): Promise<void> {
  if (await isPersonalOrg(ctx.env.DB, orgId))
    throw new ConflictError(PERSONAL_ORG_COPY.singleMember, 'ORG_PERSONAL_SINGLE_MEMBER');
  await assertNotPreviewOnly(ctx.env.DB, orgId);
}

export async function listDeveloperInvitations(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
): Promise<{ items: DeveloperInvitation[]; nextCursor: null }> {
  await devActorOf(ctx, auth, orgId, 'members:read');
  const now = ctx.clock.now();
  const rows = await listableInvitations(ctx.env.DB, orgId, now, now - LISTED_FOR);
  return { items: rows.map((row) => invitationDto(row, now)), nextCursor: null };
}

/** A failed mail leaves nothing behind: both rows are revoked, by the same actor's grant. */
async function undoInvite(
  ctx: ServiceContext,
  actor: DevActor,
  orgId: string,
  row: { id: string; org: { id: string } | null },
): Promise<void> {
  try {
    await revokeRows(
      ctx,
      actor.principal,
      actor.checks,
      { id: row.id, orgInvitationId: row.org?.id ?? null },
      auditOf(actor, orgId, 'developer_invitation.revoke', 'developer_invitation', row.id, {
        reason: 'send_failed',
      }),
    );
  } catch (error) {
    ctx.log.error('developer_invitation.compensation_failed', {
      orgId,
      code: 'DEV_INVITE_COMPENSATION_FAILED',
      error,
    });
  }
}

export async function inviteDeveloper(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  input: InviteDeveloper,
): Promise<DeveloperInvitation> {
  const actor = await devActorOf(ctx, auth, orgId, 'members:manage');
  await assertCanSponsor(ctx, orgId);
  const parsed = InviteDeveloperSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError();
  const { email } = parsed.data;
  const roles = parsed.data.roles ?? [];
  if (actor.actorType === 'api_key' && roles.some((r) => ADMINISTERING_ROLES.includes(r)))
    throw new ForbiddenError(
      'Invite an org or integration admin from the console.',
      'DEVELOPER_INVITE_ROLE_NEEDS_SESSION',
    );
  await assertIdpReady(ctx, roles.length ? ['developer', 'console'] : ['developer']);
  await checkDeveloperInviteAllowed(ctx, { actorId: actor.actorId, orgId, email });
  const now = ctx.clock.now();
  const secret = `${INVITE_PREFIX.developer}${ctx.ids.token(32)}`;
  const row = {
    id: ctx.ids.id(),
    email,
    hash: await sha256Hex(secret),
    createdByUser: actor.userId,
    createdByKey: actor.userId === null ? actor.actorId : null,
    now,
    expires: now + TTL,
    org: roles.length
      ? { id: ctx.ids.id(), roles: JSON.stringify(roles), hash: await sha256Hex(ctx.ids.token(32)) }
      : null,
  };
  const checks = [...actor.checks, developersLimit(now), ...(row.org ? [membersLimit(now)] : [])];
  try {
    await insertDeveloperInvitation(
      ctx,
      actor.principal,
      checks,
      row,
      auditOf(actor, orgId, 'developer_invitation.create', 'developer_invitation', row.id, {
        roles,
        via: actor.via,
      }),
    );
  } catch (error) {
    // Two invitations racing for one address: the grant's own check lets only one through.
    if (error instanceof AppError && error.code === 'DEVELOPER_INVITE_PENDING')
      throw new ConflictError(
        'This address already has a pending developer invitation. Revoke it to send a new one.',
        'DEVELOPER_INVITE_PENDING',
      );
    throw error;
  }
  const org = await members.orgName(ctx.env.DB, orgId);
  await assertNotPreviewOnly(ctx.env.DB, orgId);
  try {
    await createEmailBindingMailer(ctx.env).send({
      to: email,
      ...developerInvitationEmail({
        orgName: org?.name ?? 'an organization',
        roles,
        inviter: actor.userId ? await members.userName(ctx.env.DB, actor.userId) : null,
        link: `${baseUrl(ctx.env)}${INVITE_PATH}#${secret}`,
        base: baseUrl(ctx.env),
      }),
    });
  } catch {
    // Provider errors can contain message content, including the secret link, so none is logged.
    ctx.log.error('developer_invitation.send_failed', { orgId, code: 'DEV_INVITE_SEND_FAILED' });
    await undoInvite(ctx, actor, orgId, row);
    throw new UnavailableError('Unable to deliver the invitation.');
  }
  return {
    id: row.id,
    orgId,
    email,
    roles,
    state: 'pending',
    createdAt: now,
    expiresAt: row.expires,
    revokedAt: null,
  };
}

export async function revokeDeveloperInvitation(
  ctx: ServiceContext,
  auth: AuthContext,
  orgId: string,
  invitationId: string,
): Promise<void> {
  const actor = await devActorOf(ctx, auth, orgId, 'members:manage');
  const invitation = await invitationById(ctx.env.DB, orgId, invitationId);
  if (!invitation) throw new NotFoundError();
  const revoked = await revokeRows(
    ctx,
    actor.principal,
    actor.checks,
    { id: invitation.id, orgInvitationId: invitation.org_invitation_id },
    auditOf(actor, orgId, 'developer_invitation.revoke', 'developer_invitation', invitation.id, {
      reason: 'revoked',
    }),
  );
  if (!revoked)
    throw new ConflictError('The request could not be completed.', 'DEVELOPER_INVITE_CONFLICT');
}
