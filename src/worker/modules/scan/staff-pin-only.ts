import { bump, read as readCounter } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { activeRosterStatement } from './repo-staff.ts';
import {
  ANY_STAFF,
  type PinSubject,
  pinStaffListFromResult,
  preparePinReservation,
  type VerifiedPinSnapshot,
} from './staff-pin.ts';

/** Past this many active staff a PIN alone is not accepted: a name is asked for. */
export const PIN_ONLY_MAX_STAFF = 500;
/**
 * Wrong PINs, org-wide, an hour, before sign-in with no name pauses (a name is asked for). A guess
 * can hit any of the org's staff, so this is the budget for the whole org: at 15 an hour and the
 * most staff allowed, one random guess in a million per person gives about a 1% chance an hour that
 * some PIN falls, and about 0.1% at 50 staff. Named sign-in, with its per-device limits, is unaffected.
 */
export const PIN_ONLY_MISSES_PER_ORG = 15;
export const PIN_ONLY_ORG_WINDOW_MS = 60 * 60_000;

const nameNeeded = (message: string) => new AppError('STAFF_PIN_AMBIGUOUS', 409, message);

/**
 * The one active staff member who has this PIN. The per-device counters are the reservation's (a
 * miss costs the device as it does with a name); the org budget is checked first and counts every
 * miss and every shared PIN. A verified PIN is refunded from the device counters like any sign-in.
 */
export async function checkPinOnly(
  ctx: ServiceContext,
  subject: Pick<PinSubject, 'scannerId' | 'orgId'>,
  pin: string,
): Promise<VerifiedPinSnapshot> {
  const db = ctx.env.DB;
  const { orgId, scannerId } = subject;
  const now = ctx.clock.now();
  const window = now - (now % PIN_ONLY_ORG_WINDOW_MS);
  const orgKey = `scan:pinonly:${orgId}`;
  if ((await readCounter(db, orgKey, window)) >= PIN_ONLY_MISSES_PER_ORG) {
    ctx.log.warn('scan.pin_only_paused', { orgId, scannerId, code: 'PIN_ONLY_PAUSED' });
    throw nameNeeded('Too many wrong PINs. Pick your name, then enter your PIN.');
  }
  const reservation = preparePinReservation(ctx, { scannerId, orgId, staffId: ANY_STAFF });
  try {
    const results = await db.batch([
      activeRosterStatement(db, orgId, PIN_ONLY_MAX_STAFF),
      ...reservation.stmts,
    ]);
    const roster = pinStaffListFromResult(results[0]);
    if (roster.length > PIN_ONLY_MAX_STAFF)
      throw nameNeeded('Pick your name, then enter your PIN.');
    try {
      const staff = await reservation.verifyOnly(results.slice(1), roster, pin);
      if (!staff) throw new Error('PIN matched no staff snapshot');
      return staff;
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'PIN_INVALID' || error.code === 'STAFF_PIN_AMBIGUOUS')
      )
        await bump(db, orgKey, window);
      throw error;
    }
  } finally {
    // A failed refund must not fail a verified sign-in; the attempt stays counted.
    await reservation
      .refund()
      .catch((error: unknown) =>
        ctx.log.error('scan.pin_refund_failed', { code: 'PIN_REFUND', error }),
      );
  }
}
