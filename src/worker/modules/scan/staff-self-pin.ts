import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { bump } from '../../platform/counters.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanActor } from './actor.ts';
import { pinTagStateStatement, setOwnPinGrant } from './repo-pin-tag.ts';
import { getStaff } from './repo-staff.ts';
import { hashPin, pinTag } from './staff-pin-hash.ts';
import { newUniquePin } from './staff-pin-unique.ts';
import { requireSignIn, staffSession } from './staff-session.ts';

const HOUR = 3_600_000;
/** Tries an hour per person, however many devices. */
export const SELF_PIN_TRIES = 6;
/** One more draw is allowed this long after the first, on the same sign-in: a reload must not lose the PIN. */
export const SELF_PIN_REPEAT_MS = 10 * 60_000;

/**
 * `POST /scan/staff/pin`: the server replaces the signed-in person's PIN with a random one, unique in
 * the org, and returns it once. The person never chooses, so no guess can ask whether a PIN is taken.
 * Only while `pin_reset_required` (a shared PIN was seen), and never for a Manager: whoever signed in
 * as a Manager with a shared PIN cannot be told apart from the Manager, so an admin resets that PIN.
 * One repeat is allowed within 10 minutes of the first draw, on the same sign-in, without extending
 * the window; it voids the PIN drawn before it. Every draw is audited in the batch that sets it, and
 * ends the person's sign-in on every other device.
 */
export async function setOwnPin(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<{ pin: string; session: ScanSession }> {
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
    pin_issued_at: number | null;
    pin_issued_binding: string | null;
    pin_issue_repeats: number;
  }>();
  const staff = await getStaff(db, orgId, bound.id);
  if (!state || !staff || staff.authEpoch === undefined)
    throw new ConflictError('Your PIN does not need replacing.', 'STAFF_PIN_RESET_NOT_REQUIRED');
  // The sign-in as the grant restarts it: the first draw sets staff_since to `now`, the repeat checks it.
  const current = `${scanner.id}:${scanner.staffSince ?? 0}`;
  const flagged = state.pin_reset_required === 1;
  const repeat =
    !flagged &&
    state.pin_issued_at !== null &&
    now - state.pin_issued_at < SELF_PIN_REPEAT_MS &&
    state.pin_issued_binding === current &&
    state.pin_issue_repeats === 0;
  if (!flagged && !repeat)
    throw new ConflictError('Your PIN does not need replacing.', 'STAFF_PIN_RESET_NOT_REQUIRED');
  if (flagged && staff.role === 'manager')
    throw new ConflictError('Ask an admin to reset your PIN.', 'STAFF_PIN_ADMIN_RESET');
  // A clash with a PIN set at the same instant is drawn again.
  let pin = '';
  for (let attempt = 0; ; attempt++) {
    pin = await newUniquePin(ctx, orgId, staff.id, staff.pinHash);
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
          issue: repeat
            ? { kind: 'repeat', binding: current }
            : { kind: 'first', binding: `${scanner.id}:${now}` },
          audit: {
            orgId,
            actorType: 'scanner',
            actorId: scanner.id,
            action: 'scan_staff.pin_self_reset',
            targetType: 'scan_staff',
            targetId: staff.id,
          },
        },
      );
      break;
    } catch (error) {
      if (attempt < 2 && classifyD1Error(error)?.kind === 'unique') continue;
      throw error;
    }
  }
  return { pin, session: await staffSession(ctx, actor) };
}
