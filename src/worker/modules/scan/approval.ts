import type { z } from 'zod';
import type { ScanApprovalSchema } from '../../../shared/contracts/scan.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './guard.ts';
import { namedDayCountsStatement } from './repo-pin-tag.ts';
import { approverStatement, managerRosterStatement } from './repo-staff.ts';
import {
  ANY_MANAGER,
  type PinReservationGuard,
  pinStaffFromResult,
  pinStaffListFromResult,
  preparePinReservation,
  type VerifiedPinSnapshot,
} from './staff-pin.ts';
import { assertNamedDayRows, countNamedMiss, dayWindowOf } from './staff-pin-day.ts';

/** Until help requests land (SD2, SD14), only the PIN form of an approval is accepted. */
export function pinApprovalOnly<A extends object>(
  approval: A | undefined,
): Extract<A, { pin: string }> | undefined {
  if (!approval) return undefined;
  if ('pin' in approval) return approval as Extract<A, { pin: string }>;
  if ('requestId' in approval)
    throw new AppError(
      'APPROVAL_GRANT_INVALID',
      409,
      'This approval expired. Ask again or enter a PIN.',
    );
  throw new AppError('APPROVE_AS_NOT_ALLOWED', 403, 'Approve as is off here. Enter a PIN.');
}

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
  // The PIN is tested against every manager: that count sets what an attempt costs.
  const testedManagers = staffId
    ? 1
    : (await managerRosterStatement(db, orgId).all()).results.length;
  const reservation = preparePinReservation(
    ctx,
    {
      scannerId: actor.scanner?.id ?? actor.actorKey,
      orgId,
      staffId: staffId ?? ANY_MANAGER,
      testedManagers,
    },
    guard,
  );
  const scannerId = actor.scanner?.id ?? actor.actorKey;
  // Only a name that exists is counted, so made-up names cannot fill the counters.
  let known = false;
  try {
    // The named day counters are read in the same batch (no extra trip); a spent day refuses before the PIN is checked.
    const day = staffId
      ? [namedDayCountsStatement(db, staffId, scannerId, dayWindowOf(ctx.clock.now()))]
      : [];
    const all = await db.batch([
      approverStatement(db, orgId, staffId),
      ...reservation.stmts,
      ...day,
    ]);
    const results = all.slice(0, all.length - day.length);
    known = pinStaffFromResult(results[0]) !== null;
    if (staffId)
      assertNamedDayRows(
        ctx,
        (all.at(-1)?.results ?? []) as { key: string; count: number }[],
        scannerId,
        staffId,
      );
    return staffId
      ? await reservation.verify(results.slice(1), pinStaffFromResult(results[0]), pin, true)
      : await reservation.verifyAny(results.slice(1), pinStaffListFromResult(results[0]), pin);
  } catch (error) {
    // A named approval counts against the person's day like a named sign-in does.
    if (staffId && known) await countNamedMiss(ctx, { orgId, scannerId, staffId }, error);
    throw error;
  } finally {
    await reservation.refund();
  }
}
