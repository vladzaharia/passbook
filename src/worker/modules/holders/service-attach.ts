import { strictEmail } from '../../../shared/email.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Actor } from '../passes/service.ts';
import { userVerifiedEmail, waitingPassIds } from './repo-queries.ts';
import { runAttachHookA } from './service.ts';

/** Inline attaches per verification; the minute sweep (`resumeVerifiedHolderAttachments`) does the rest. */
export const INLINE_ATTACH_CAP = 10;

/**
 * Hook B: stage transfers for waiting passes after the caller verifies the address. Runs inside
 * sign-in, so a pass that cannot attach stays waiting for the sweep instead of failing the caller.
 * `auditActor` names who added the address (an admin); the transfer itself rests on the owner's proof.
 * Returns the number of transfers started, including those still pending provider retirement.
 */
export async function attachWaitingPassesForEmail(
  ctx: ServiceContext,
  userId: string,
  email: string,
  auditActor?: Actor,
): Promise<number> {
  const normalized = strictEmail(email);
  // The caller's word is not proof: the address must be verified for this user right now.
  const verified = await userVerifiedEmail(ctx.env.DB, userId, normalized ?? '');
  if (!normalized || !verified) return 0;
  const ids = await waitingPassIds(ctx.env.DB, normalized, INLINE_ATTACH_CAP + 1);
  if (ids.length > INLINE_ATTACH_CAP)
    ctx.log.info('holder.attach_deferred', { userId, code: 'ATTACH_CAPPED' });
  const options = { expectedUserId: userId, auditActor };
  let started = 0;
  for (const id of ids.slice(0, INLINE_ATTACH_CAP)) {
    try {
      if (await runAttachHookA(ctx, id, { type: 'user', id: userId }, options)) started++;
    } catch (error) {
      // A refusal (release, signing, stale pass) is expected and retried by the sweep; anything else is a fault.
      if (error instanceof AppError)
        ctx.log.warn('holder.attach_deferred', { passId: id, userId, code: error.code });
      else
        ctx.log.error('holder.attach_deferred', {
          passId: id,
          userId,
          code: 'ATTACH_FAILED',
          error,
        });
    }
  }
  return started;
}
