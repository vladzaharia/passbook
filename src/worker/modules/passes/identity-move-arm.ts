import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { moveById } from './repo-identity-move.ts';
import { anyRegistration, arm } from './repo-identity-move-timers.ts';
import { getPass } from './repo-read-pass.ts';

/**
 * Starts the old pass's 24 hours now, for a replacement registered on a device that does not hold the old pass
 * (an admin has checked the two are the same phone). The route owns the session, step-up and the audit's actor.
 */
export async function armMoveNow(
  ctx: ServiceContext,
  by: { userId: string },
  orgId: string,
  moveId: string,
): Promise<void> {
  const db = ctx.env.DB;
  const row = await moveById(db, moveId);
  if (!row || row.org_id !== orgId) throw new NotFoundError('Move not found.');
  const made = await getPass(db, row.new_pass_id, orgId);
  const reg = made?.status === 'active' ? await anyRegistration(db, row.new_pass_id) : null;
  const now = ctx.clock.now();
  // The 24 hours start now, so the holder has a day from the admin's call, not from a registration weeks old.
  if (!reg || !(await arm(db, row.id, { at: now, device: reg.device }, now)))
    throw new ConflictError(
      'The new pass is not registered on a device, or the move is not waiting. Check the move.',
      'IDENTITY_MOVE_CONFLICT',
    );
  await recordAudit(ctx, {
    orgId,
    actorType: 'user',
    actorId: by.userId,
    action: 'identity.move_armed',
    targetType: 'pass',
    targetId: row.old_pass_id,
    detail: { moveId },
  });
}
