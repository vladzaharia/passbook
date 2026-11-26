import type { z } from 'zod';
import type { InvitationChallengeSchema } from '../../../../shared/contracts/invitations.ts';
import { TURNSTILE_INVITE_ACTION } from '../../../../shared/turnstile.ts';
import { BadRequestError, ForbiddenError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { verifyTurnstile } from '../../auth/turnstile.ts';
import { assertIdpReady, type IdpNeed } from '../../dev-access/availability.ts';
import type { WriteCtx } from '../types.ts';
import { type Invite, resolveInvite } from './resolve.ts';

export const invalidInvitation = () =>
  new BadRequestError('This invitation is invalid or expired.', 'INVITATION_INVALID');

/** Who a binding write is for, in the ledger: the invitation, and the service as the actor (no session exists yet). */
export const ledgerOf = (invite: Invite, reason: string): WriteCtx => ({
  ref: invite.row.id,
  reason,
  actor: { kind: 'system', job: 'invitations' },
});

/** The groups an invitation puts a person in decide which of them Polaris ID must have. */
export const challengeNeeds = (invite: Invite): IdpNeed[] =>
  invite.kind === 'member'
    ? ['console']
    : invite.row.member_id === null
      ? ['developer']
      : ['developer', 'console'];

/**
 * An invitation that may still start a Polaris ID path (make an account, or find one): open and not past its first
 * window, after a Turnstile check, with Polaris ID live. The page keeps working without Polaris ID: this is the
 * part that needs it.
 */
export async function challengedInvite(
  ctx: ServiceContext,
  ip: string | null,
  input: z.infer<typeof InvitationChallengeSchema>,
): Promise<Invite> {
  const invite = await resolveInvite(ctx, input.token);
  if (invite?.state !== 'pending' || invite.late) throw invalidInvitation();
  if (
    !(await verifyTurnstile(
      ctx.env,
      input.turnstileToken,
      ip,
      ctx.log,
      fetch,
      TURNSTILE_INVITE_ACTION,
    ))
  ) {
    ctx.log.warn('invitation.turnstile_failed', { code: 'TURNSTILE_FAILED' });
    throw new ForbiddenError('Verification failed. Try again.', 'TURNSTILE_FAILED');
  }
  await assertIdpReady(ctx, challengeNeeds(invite));
  return invite;
}
