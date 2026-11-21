import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { bump } from '../../platform/counters.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { AppError, ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScanActor } from './actor.ts';
import { pinTagStateStatement, setOwnPinGrant } from './repo-pin-tag.ts';
import { getStaff } from './repo-staff.ts';
import { hashPin, pinTag } from './staff-pin-hash.ts';
import { pinInUse } from './staff-pin-unique.ts';
import { requireSignIn, staffSession } from './staff-session.ts';

const HOUR = 3_600_000;
/** Tries an hour per person, however many devices. */
export const SELF_PIN_TRIES = 6;

/** The same answer for a weak PIN and for one someone else has: it never says who. */
const weak = () => new AppError('PIN_WEAK', 400, 'Choose a different PIN.');

/** All one digit, or a run up or down. */
export const isWeakPin = (pin: string) =>
  /^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin);

/**
 * `POST /scan/staff/pin`: the signed-in person replaces their own PIN. Only while `pin_reset_required`
 * (a shared PIN was seen), so a stolen session cannot rotate a PIN that is fine.
 */
export async function setOwnPin(
  ctx: ServiceContext,
  actor: ScanActor,
  pin: string,
): Promise<ScanSession> {
  const scanner = requireSignIn(actor);
  const bound = actor.staff;
  if (!bound) throw new ConflictError('Sign in first.', 'STAFF_SIGN_IN_REQUIRED');
  const { orgId } = actor;
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  if ((await bump(db, `scan:pinself:${bound.id}`, now - (now % HOUR))) > SELF_PIN_TRIES)
    throw new RateLimitedError(Math.ceil((HOUR - (now % HOUR)) / 1000));
  const state = await pinTagStateStatement(db, orgId, bound.id).first<{
    pin_reset_required: number;
  }>();
  const staff = await getStaff(db, orgId, bound.id);
  if (!state?.pin_reset_required || !staff || staff.authEpoch === undefined)
    throw new ConflictError('Your PIN does not need replacing.', 'STAFF_PIN_RESET_NOT_REQUIRED');
  if (isWeakPin(pin) || (await pinInUse(ctx, orgId, pin, staff.id, staff.pinHash))) throw weak();
  try {
    await setOwnPinGrant(
      ctx,
      scanner,
      { id: staff.id, authEpoch: staff.authEpoch },
      {
        pinHash: await hashPin(ctx.env, staff.id, pin),
        pinTag: await pinTag(ctx.env, orgId, pin),
        macVersion: macKeyVersion(ctx.env),
        now,
      },
    );
  } catch (error) {
    // Two people choosing the same PIN at once: the second is told as a weak one.
    if (classifyD1Error(error)?.kind === 'unique') throw weak();
    throw error;
  }
  await auditStmt(db, ctx, {
    orgId,
    actorType: 'scanner',
    actorId: scanner.id,
    action: 'scan_staff.pin_self_reset',
    targetType: 'scan_staff',
    targetId: staff.id,
  }).run();
  return staffSession(ctx, actor);
}
