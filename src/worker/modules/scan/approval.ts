import type { z } from 'zod';
import type { ScanApprovalSchema } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { staffStatement } from './repo-staff.ts';
import {
  type PinReservationGuard,
  pinStaffFromResult,
  preparePinReservation,
  type VerifiedPinSnapshot,
} from './staff-pin.ts';

/**
 * A Manager's PIN for one action (SA 2.7). Verified here and stored nowhere: the scan row keeps
 * only `approved_by`. A PIN that is right but belongs to a Door or Desk person is a plain miss.
 */
export async function verifyApproval(
  ctx: ServiceContext,
  actor: ScanActor,
  approval: z.infer<typeof ScanApprovalSchema>,
  guard: PinReservationGuard,
): Promise<VerifiedPinSnapshot | null> {
  if (!guard) throw new Error('PIN approval requires an authority guard');
  const db = ctx.env.DB;
  const { staffId, pin } = approval;
  const orgId = actor.orgId;
  const reservation = preparePinReservation(
    ctx,
    {
      scannerId: actor.scanner?.id ?? actor.actorKey,
      orgId,
      staffId,
    },
    guard,
  );
  try {
    const results = await db.batch([staffStatement(db, orgId, staffId), ...reservation.stmts]);
    const manager = await reservation.verify(
      results.slice(1),
      pinStaffFromResult(results[0]),
      pin,
      true,
    );
    return manager;
  } finally {
    await reservation.refund();
  }
}
