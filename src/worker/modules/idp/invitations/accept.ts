import type { InvitationAccept } from '../../../../shared/contracts/invitations.ts';
import type { OrgMembership } from '../../../../shared/contracts/org-membership.ts';
import { hasDeveloperAccess } from '../../../../shared/spaces.ts';
import type { SessionAuth } from '../../../platform/auth.ts';
import { ConflictError, ForbiddenError, IdpSignInRequiredError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { assertIdpReady, developerLimit } from '../../dev-access/availability.ts';
import { pendingCount } from '../../dev-access/repo.ts';
import { type GroupSource, liveSponsorCount } from '../../dev-access/repo-sponsors.ts';
import { getOrgAccess } from '../../orgs/access.ts';
import { idpClient } from '../client.ts';
import { claimsOfInvitation } from '../repo-invite-claims.ts';
import { subjectsOfUser } from '../repo-sources.ts';
import { challengeNeeds, invalidInvitation } from './challenge.ts';
import { claimAccount } from './claim-existing.ts';
import { acceptedBy, hasEmail, setupsOf } from './repo-resolve.ts';
import { acceptDeveloper, acceptMember } from './repo-writes.ts';
import { type Invite, maskEmail, resolveInvite } from './resolve.ts';

const changed = () =>
  new ConflictError('The request could not be completed.', 'INVITATION_CONFLICT');

/** The Polaris ID subject the person made from this invitation's signup tokens, when they did. */
async function madeHere(
  ctx: ServiceContext,
  invite: Invite,
  subjects: readonly string[],
): Promise<string | null> {
  const setups = await setupsOf(ctx.env.DB, invite.kind, invite.row.id);
  if (setups.length === 0 || subjects.length === 0) return null;
  // Records the proof for every account the tokens made, which is what lets the drain take their groups back.
  const proof = await idpClient(ctx.env, ctx.log).proveSignup(setups.map((s) => s.idp_token_id));
  const made = new Set(proof?.matches.map((m) => m.subject));
  return subjects.find((s) => made.has(s)) ?? null;
}

async function outcomeOf(
  ctx: ServiceContext,
  invite: Invite,
  userId: string,
  outcome: InvitationAccept['outcome'],
): Promise<InvitationAccept> {
  const membership: OrgMembership | null = invite.row.member_id
    ? await getOrgAccess(ctx, userId, invite.row.org_id)
    : null;
  return { outcome, kind: invite.kind, orgName: invite.row.org_name, membership };
}

async function acceptMemberInvite(
  ctx: ServiceContext,
  invite: Invite,
  userId: string,
): Promise<InvitationAccept> {
  const membershipId = ctx.ids.id();
  const landed = await acceptMember(ctx, {
    invitationId: invite.row.id,
    orgId: invite.row.org_id,
    userId,
    membershipId,
    now: ctx.clock.now(),
  });
  if (!landed) throw invalidInvitation();
  const membership = await getOrgAccess(ctx, userId, invite.row.org_id);
  if (!membership || membership.id !== membershipId) throw changed();
  return { outcome: 'joined', kind: 'member', orgName: invite.row.org_name, membership };
}

/** How a developer invitation's group got onto the account: made from a token, claimed, already held, or added now. */
async function developerPath(
  ctx: ServiceContext,
  invite: Invite,
  session: SessionAuth,
  subjects: readonly string[],
): Promise<{ source: GroupSource; subject: string }> {
  const now = ctx.clock.now();
  const made = await madeHere(ctx, invite, subjects);
  if (made) return { source: 'signup', subject: made };
  const claim = (await claimsOfInvitation(ctx.env.DB, { developer: invite.row.id })).find(
    (c) => subjects.includes(c.subject) && c.swept_at === null && c.claim_until > now,
  );
  if (claim) return { source: 'added', subject: claim.subject };
  const subject = subjects[0];
  if (!subject) throw new IdpSignInRequiredError('/auth/oidc/start?next=/invite');
  if (hasDeveloperAccess(session.roles)) return { source: 'existing', subject };
  // The strong session holds the invited address verified, which is the mailbox proof a claim needs.
  await assertIdpReady(ctx, challengeNeeds(invite));
  await claimAccount(ctx, invite, subject);
  return { source: 'added', subject };
}

async function acceptDeveloperInvite(
  ctx: ServiceContext,
  invite: Invite,
  session: SessionAuth,
  subjects: readonly string[],
): Promise<InvitationAccept> {
  const { row } = invite;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const limit = await developerLimit(ctx, row.org_id);
  if (limit !== null) {
    const held =
      (await liveSponsorCount(db, row.org_id)) + (await pendingCount(db, row.org_id, now));
    // This invitation counts while it is pending; once past `expires_at` it no longer does.
    if (held - (now < row.expires_at ? 1 : 0) >= limit)
      throw new ConflictError(
        'This organization has no developer seats left.',
        'DEVELOPER_LIMIT_REACHED',
      );
  }
  const { source, subject } = await developerPath(ctx, invite, session, subjects);
  const landed = await acceptDeveloper(ctx, {
    invitationId: row.id,
    orgId: row.org_id,
    userId: session.userId,
    subject,
    source,
    memberInvitationId: row.member_id,
    membershipId: ctx.ids.id(),
    sponsorId: ctx.ids.id(),
    now,
  });
  if (!landed) throw changed();
  return outcomeOf(
    ctx,
    invite,
    session.userId,
    hasDeveloperAccess(session.roles) ? 'joined' : 'refresh',
  );
}

/**
 * Accepts an invitation as the signed-in person: a strong Polaris ID session (the route enforces it, with CSRF) that
 * holds the invited address verified. One path for every kind. A member invitation joins the org; a developer one
 * records the sponsorship (and the paired membership) in one batch. The same person asking again gets the same answer.
 * `only` limits the kind a route serves.
 */
export async function acceptInvitation(
  ctx: ServiceContext,
  session: SessionAuth,
  token: string,
  only?: Invite['kind'],
): Promise<InvitationAccept> {
  const invite = await resolveInvite(ctx, token);
  if (!invite || (only && invite.kind !== only)) throw invalidInvitation();
  const db = ctx.env.DB;
  if (invite.state === 'accepted') {
    // A developer invitation may be answered again for the person who accepted it (the page's retry after a refresh);
    // a member invitation is single use.
    if (invite.kind !== 'developer') throw invalidInvitation();
    const by = await acceptedBy(db, invite.kind, invite.row.id);
    if (by?.user_id !== session.userId) throw invalidInvitation();
    return outcomeOf(ctx, invite, session.userId, 'joined');
  }
  if (invite.state !== 'pending') throw invalidInvitation();
  if (!(await hasEmail(db, session.userId, invite.row.email)))
    throw new ForbiddenError(
      `This invitation is for ${maskEmail(invite.row.email)}. Sign in with that address.`,
      'INVITATION_EMAIL_MISMATCH',
    );
  const subjects = await subjectsOfUser(db, session.userId);
  if (invite.kind === 'member') {
    // The proof binds an account made from a token to the invitation; without tokens this is a plain accept.
    await madeHere(ctx, invite, subjects);
    return acceptMemberInvite(ctx, invite, session.userId);
  }
  return acceptDeveloperInvite(ctx, invite, session, subjects);
}
