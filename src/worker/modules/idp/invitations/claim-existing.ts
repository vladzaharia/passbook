import type { z } from 'zod';
import type { InvitationChallengeSchema } from '../../../../shared/contracts/invitations.ts';
import { AppError } from '../../../platform/errors.ts';
import { enforceRateLimit } from '../../../platform/rate-limit.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { idpClient } from '../client.ts';
import { claimsOfInvitation } from '../repo-invite-claims.ts';
import { challengedInvite, ledgerOf } from './challenge.ts';
import { signupSpecOf, targetsOfSpec } from './groups.ts';
import { insertClaim } from './repo-writes.ts';
import type { Invite } from './resolve.ts';

const DAY = 24 * 60 * 60 * 1000;
const CLAIM_CAP = 3;

/**
 * Gives an existing Polaris ID account what the invitation carries, at once, and records why (a claim row the sweep
 * settles if nobody accepts in time). Repeating it for the same account changes nothing.
 */
export async function claimAccount(
  ctx: ServiceContext,
  invite: Invite,
  subject: string,
): Promise<void> {
  const db = ctx.env.DB;
  const { row, kind } = invite;
  const parent = kind === 'member' ? { org: row.id } : { developer: row.id };
  const claims = await claimsOfInvitation(db, parent);
  if (claims.length >= CLAIM_CAP && !claims.some((c) => c.subject === subject))
    throw new AppError(
      'INVITATION_CLAIM_CAPPED',
      429,
      'Too many accounts tried this invitation. Ask for a new invitation.',
    );
  const now = ctx.clock.now();
  const until =
    kind === 'member'
      ? Math.min(now + DAY, row.expires_at + DAY)
      : Math.max(row.claim_until ?? 0, now + DAY);
  // A repeat for an account that already claimed writes nothing (the trigger would refuse a fourth row at the cap).
  if (!claims.some((c) => c.subject === subject))
    await insertClaim(
      ctx,
      { id: ctx.ids.id(), kind, invitationId: row.id, subject, now, claimUntil: until },
      {
        orgId: row.org_id,
        actorType: 'system',
        action: `${kind === 'member' ? 'org' : 'developer'}_invitation.claim`,
        targetType: `${kind === 'member' ? 'org' : 'developer'}_invitation`,
        targetId: row.id,
      },
    );
  const spec = await signupSpecOf(db, invite);
  await idpClient(ctx.env, ctx.log).apply(
    subject,
    { add: targetsOfSpec(spec) },
    ledgerOf(invite, 'invitation.claim'),
  );
}

/**
 * "I have a Polaris ID": the click from the invitation email proves the mailbox, so the account that has the invited
 * address verified gets the groups now and can sign in. No account, or more than one: nothing happens.
 */
export async function claimExisting(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<void> {
  const invite = await challengedInvite(ctx, ip, input);
  // One link holder cannot spend the binding's directory-search and write budgets, which the whole platform shares.
  await enforceRateLimit(ctx.env, 'RL_MAGIC_LINK', `invitation-claim:${invite.row.id}`);
  const parent = invite.kind === 'member' ? { org: invite.row.id } : { developer: invite.row.id };
  const now = ctx.clock.now();
  // An open claim already named the account and applied its groups (the drain finishes it if that failed): no search.
  if (
    (await claimsOfInvitation(ctx.env.DB, parent)).some(
      (c) => c.swept_at === null && c.claim_until > now,
    )
  )
    return;
  const found = await idpClient(ctx.env, ctx.log).findByVerifiedEmail(
    invite.row.email,
    ledgerOf(invite, 'invitation.find'),
  );
  if (!found)
    throw new AppError(
      'INVITATION_NO_ACCOUNT',
      404,
      'No Polaris ID uses this address. Create one.',
    );
  await claimAccount(ctx, invite, found.subject);
}
