import type { z } from 'zod';
import type {
  InvitationAccept,
  InvitationChallengeSchema,
  InvitationConfirm,
  InvitationPreview,
  InvitationSetup,
} from '../../../../shared/contracts/invitations.ts';
import { hasDeveloperAccess } from '../../../../shared/spaces.ts';
import type { SessionAuth } from '../../../platform/auth.ts';
import { bump, read } from '../../../platform/counters.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  IdpSignInRequiredError,
} from '../../../platform/errors.ts';
import { enforceRateLimit } from '../../../platform/rate-limit.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { assertIdpReady, idpReady } from '../../dev-access/availability.ts';
import { idpClient } from '../client.ts';
import { markDirty } from '../repo-dirty.ts';
import { claimsOfInvitation } from '../repo-invite-claims.ts';
import { signedInSubject, subjectsOfUser } from '../repo-sources.ts';
import { assertHuman, invalidInvitation } from './challenge.ts';
import {
  acceptPlatformSubject,
  claimPlatformAccount,
  grantPlatformGroups,
} from './platform-accept.ts';
import { ledgerOfPlatform, platformSignupSpec } from './platform-groups.ts';
import { type PlatformInvite, resolvePlatform } from './platform-resolve.ts';
import { INVITE_REASON } from './reasons.ts';
import { groupNames, insertPlatformSetup } from './repo-platform.ts';
import { hasEmail, setupsOf } from './repo-resolve.ts';
import { maskEmail } from './resolve.ts';

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const NONE_MEMORY_MIN = 10;
const SEARCHES_PER_DAY = 5;
const SETUP_CAP = 3;
const minuteOf = (t: number) => t - (t % MINUTE);
const needsOf = (invite: PlatformInvite) => (invite.developer ? (['developer'] as const) : []);

const mismatch = () =>
  new ForbiddenError("This account doesn't use the invited address.", 'INVITATION_EMAIL_MISMATCH');

/** What a pending platform invitation joins, for the page. */
export async function previewPlatform(
  ctx: ServiceContext,
  invite: PlatformInvite,
): Promise<InvitationPreview> {
  const names = await groupNames(ctx.env.DB, invite.groups);
  return {
    kind: 'platform',
    orgName: null,
    groups: invite.groups.map((key) => names.get(key) ?? key),
    roles: [],
    developer: invite.developer,
    email: maskEmail(invite.row.email),
    expiresAt: invite.row.expires_at,
    polaris: !invite.late && (await idpReady(ctx, needsOf(invite))),
  };
}

/** A platform invitation that may still start a Polaris ID path: open, not late, Turnstile passed, Polaris ID live. */
async function challengedPlatform(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<PlatformInvite> {
  const invite = await resolvePlatform(ctx, input.token);
  if (invite?.state !== 'pending' || invite.late) throw invalidInvitation();
  await assertHuman(ctx, ip, input.turnstileToken);
  await assertIdpReady(ctx, needsOf(invite));
  return invite;
}

/**
 * "Create a Polaris ID": a one-hour, one-use signup token with no groups, minted at the click.
 * Only its id is kept. A fourth link is refused; a new one withdraws an unused earlier one.
 */
export async function setupPlatform(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<InvitationSetup> {
  const invite = await challengedPlatform(ctx, ip, input);
  const db = ctx.env.DB;
  const { row } = invite;
  const earlier = await setupsOf(db, 'platform', row.id);
  if (earlier.length >= SETUP_CAP)
    throw new AppError(
      'INVITATION_SETUP_CAPPED',
      429,
      'Too many links for this invitation. Ask for a new invitation.',
    );
  const rpc = idpClient(ctx.env, ctx.log);
  const write = ledgerOfPlatform(invite, INVITE_REASON.setup);
  const signup = await rpc.createSignup(platformSignupSpec(), write);
  if ('dryRun' in signup)
    throw new AppError(
      'IDP_UNAVAILABLE',
      503,
      'Polaris ID is not reachable. Try again in a few minutes.',
    );
  const now = ctx.clock.now();
  try {
    await insertPlatformSetup(
      ctx,
      {
        invitationId: row.id,
        tokenId: signup.tokenId,
        now,
        expires: signup.expiresAt,
        claimUntil: now + DAY,
      },
      {
        actorType: 'system',
        action: 'idp.invite_platform',
        targetType: 'platform_invitation',
        targetId: row.id,
        detail: { op: 'setup', n: earlier.length + 1 },
      },
    );
  } catch (error) {
    // The token exists in Polaris ID but nothing here points at it: withdraw it.
    await rpc.deleteSignup(signup.tokenId, write).catch(() => undefined);
    throw error;
  }
  for (const other of await setupsOf(db, 'platform', row.id)) {
    const older =
      other.created_at < now || (other.created_at === now && other.idp_token_id < signup.tokenId);
    if (older && other.expires_at > now)
      await rpc.deleteSignup(other.idp_token_id, write).catch(() => {
        ctx.log.warn('invitation.setup_unwithdrawn', { code: 'INVITATION_SETUP_UNWITHDRAWN' });
      });
  }
  return { setupUrl: signup.url, expiresAt: signup.expiresAt };
}

/**
 * "I have a Polaris ID": the click from the email proves the mailbox, so the account that has the invited address
 * verified gets the groups now. Without developer access that is the whole invitation, accepted at once and with no
 * PassBook sign-in; with it, the person signs in and accepts.
 */
export async function claimExistingPlatform(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<void> {
  const invite = await challengedPlatform(ctx, ip, input);
  await enforceRateLimit(ctx.env, 'RL_MAGIC_LINK', `invitation-claim:${invite.row.id}`);
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const noAccount = () =>
    new AppError('INVITATION_NO_ACCOUNT', 404, 'No Polaris ID uses this address. Create one.');
  // An open claim already named the account (the drain finishes it if the write failed): no search.
  const open = (await claimsOfInvitation(db, { platform: invite.row.id })).find(
    (c) => c.swept_at === null && c.claim_until > now,
  );
  let subject = open?.subject;
  if (!subject) {
    // The directory search is the binding's scarce, platform-wide budget: a remembered "no account" and a daily cap.
    for (let back = 0; back < NONE_MEMORY_MIN; back++)
      if ((await read(db, `invclaim:none:${invite.row.id}`, minuteOf(now) - back * MINUTE)) > 0)
        throw noAccount();
    if ((await bump(db, `invclaim:search:${invite.row.id}`, now - (now % DAY))) > SEARCHES_PER_DAY)
      throw noAccount();
    const found = await idpClient(ctx.env, ctx.log).findByVerifiedEmail(
      invite.row.email,
      ledgerOfPlatform(invite, INVITE_REASON.find),
    );
    if (!found) {
      await bump(db, `invclaim:none:${invite.row.id}`, minuteOf(now));
      throw noAccount();
    }
    subject = found.subject;
  }
  await claimPlatformAccount(ctx, invite, subject);
  if (!invite.developer) await acceptPlatformSubject(ctx, invite, subject, null);
}

/**
 * After "Done" on the page: for each signup token the invitation made, `proveSignup` finds the account and compares
 * its verified address with the invited one, without returning it. A match gets the groups and accepts; an account
 * made from a forwarded link with another address never had any. Repeating it after the accept is a no-op.
 */
export async function confirmPlatform(
  ctx: ServiceContext,
  token: string,
): Promise<InvitationConfirm> {
  const invite = await resolvePlatform(ctx, token);
  if (!invite) throw invalidInvitation();
  if (invite.state === 'accepted') return { outcome: 'joined' };
  if (invite.state !== 'pending') throw invalidInvitation();
  if (invite.developer) throw new IdpSignInRequiredError('/auth/oidc/start?next=/invite');
  const db = ctx.env.DB;
  const rpc = idpClient(ctx.env, ctx.log);
  const setups = await setupsOf(db, 'platform', invite.row.id);
  let matched: string | null = null;
  let unverified = false;
  const others = new Set<string>();
  const wrong = new Set<string>();
  for (const setup of setups) {
    const proof = await rpc.proveSignup([setup.idp_token_id], { email: invite.row.email });
    if (!proof) continue;
    switch (proof.emailMatch) {
      case 'match':
        if (matched === null) matched = proof.subject;
        else others.add(proof.subject);
        break;
      case 'mismatch':
        wrong.add(proof.subject);
        break;
      default:
        unverified = true;
    }
  }
  if (matched === null) {
    for (const subject of wrong) await markDirty(db, subject);
    if (wrong.size > 0) throw mismatch();
    if (unverified)
      throw new ConflictError(
        'Confirm your email in Polaris ID, then try again.',
        'INVITATION_EMAIL_UNVERIFIED',
      );
    throw new ConflictError('Finish creating your Polaris ID first.', 'INVITATION_NOT_STARTED');
  }
  await grantPlatformGroups(ctx, invite, matched);
  await acceptPlatformSubject(ctx, invite, matched, null, [...others, ...wrong]);
  return { outcome: 'joined' };
}

/**
 * A platform invitation with developer access, accepted by the signed-in person (a strong Polaris ID session that
 * holds the invited address verified): their account gets the groups and the platform developer grant is written.
 * The same person asking again gets the same answer.
 */
export async function acceptPlatformInvite(
  ctx: ServiceContext,
  session: SessionAuth,
  token: string,
): Promise<InvitationAccept> {
  const invite = await resolvePlatform(ctx, token);
  if (!invite?.developer) throw invalidInvitation();
  const db = ctx.env.DB;
  const subjects = await subjectsOfUser(db, session.userId);
  const outcome = (): InvitationAccept => ({
    outcome: hasDeveloperAccess(session.roles) ? 'joined' : 'refresh',
    kind: 'platform',
    orgName: null,
    membership: null,
  });
  if (invite.state === 'accepted') {
    if (!invite.row.accepted_subject || !subjects.includes(invite.row.accepted_subject))
      throw invalidInvitation();
    return outcome();
  }
  if (invite.state !== 'pending') throw invalidInvitation();
  if (!(await hasEmail(db, session.userId, invite.row.email))) throw mismatch();
  await assertIdpReady(ctx, needsOf(invite));
  const rpc = idpClient(ctx.env, ctx.log);
  // An account made from this invitation's token, as proven by the binding, is the one; else the person's own.
  const setups = await setupsOf(db, 'platform', invite.row.id);
  const proof = setups.length ? await rpc.proveSignup(setups.map((s) => s.idp_token_id)) : null;
  const made = [...new Set(proof?.matches.map((m) => m.subject))];
  const subject =
    subjects.find((s) => made.includes(s)) ?? (await signedInSubject(db, session.userId));
  if (!subject) throw new IdpSignInRequiredError('/auth/oidc/start?next=/invite');
  if (made.includes(subject)) await grantPlatformGroups(ctx, invite, subject);
  else await claimPlatformAccount(ctx, invite, subject);
  await acceptPlatformSubject(ctx, invite, subject, session.userId, made);
  return outcome();
}
