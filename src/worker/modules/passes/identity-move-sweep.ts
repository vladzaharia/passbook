import { writeEvent } from '../../platform/analytics.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { isOrgActive } from '../orgs/active.ts';
import { remindDue, voidDue } from './identity-move.ts';
import { revokeReplacement } from './identity-move-revoke.ts';
import {
  arm,
  dueReminders,
  dueVoids,
  flagUnarmed,
  revokedOld,
  unarmed,
} from './repo-identity-move-timers.ts';

const BATCH = 50;

/**
 * The minute hook: arms what the register hook missed, counts the replacements registered for 7 days that never
 * armed (`move.unarmed`, and `unarmed` on the row), voids what is due, sends the reminders that are.
 */
export async function sweepIdentityMoves(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  for (const row of await revokedOld(db, now, BATCH))
    try {
      if (await isOrgActive(ctx, row.org_id)) await revokeReplacement(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.revoke_failed', {
        code: 'IDENTITY_MOVE_REVOKE',
        moveId: row.id,
        error,
      });
    }
  for (const { id, at, device } of await unarmed(db, BATCH)) await arm(db, id, { at, device }, now);
  for (const { id, org_id } of await flagUnarmed(db, now, BATCH)) {
    ctx.log.warn('identity_move.unarmed', { code: 'IDENTITY_MOVE_UNARMED', moveId: id });
    writeEvent(ctx.env, { event: 'move.unarmed', orgId: org_id, outcome: 'unarmed' }, ctx.log);
  }
  for (const row of await dueVoids(db, now, BATCH))
    try {
      await voidDue(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.void_failed', {
        code: 'IDENTITY_MOVE_VOID',
        moveId: row.id,
        error,
      });
    }
  for (const row of await dueReminders(db, now, BATCH))
    try {
      await remindDue(ctx, row);
    } catch (error) {
      ctx.log.error('identity_move.remind_failed', {
        code: 'IDENTITY_MOVE_REMIND',
        moveId: row.id,
        error,
      });
    }
}
