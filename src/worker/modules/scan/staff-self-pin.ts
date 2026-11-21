import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { bump } from '../../platform/counters.ts';
import { macKeyVersion } from '../../platform/crypto.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScanActor } from './actor.ts';
import { pinTagStateStatement, recentSelfResetStatement, setOwnPinGrant } from './repo-pin-tag.ts';
import { getStaff } from './repo-staff.ts';
import { hashPin, pinTag } from './staff-pin-hash.ts';
import { newUniquePin } from './staff-pin-unique.ts';
import { requireSignIn, staffSession } from './staff-session.ts';

const HOUR = 3_600_000;
/** Tries an hour per person, however many devices. */
export const SELF_PIN_TRIES = 6;
/** After a reset, the same scanner may draw another PIN this long: a reload must not lose the first. */
export const SELF_PIN_REPEAT_MS = 10 * 60_000;

/**
 * `POST /scan/staff/pin`: the server replaces the signed-in person's PIN with a random one, unique in
 * the org, and returns it once. The person never chooses, so no guess can ask whether a PIN is taken.
 * Only while `pin_reset_required` (a shared PIN was seen), or within 10 minutes of
 * this scanner's last reset for the same person (a reload before the PIN was typed back), so a stolen
 * session cannot rotate a PIN that is fine. A repeat voids the PIN drawn before it.
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
  }>();
  const staff = await getStaff(db, orgId, bound.id);
  const flagged = state?.pin_reset_required === 1;
  const repeat =
    !flagged &&
    (await recentSelfResetStatement(
      db,
      orgId,
      scanner.id,
      bound.id,
      now - SELF_PIN_REPEAT_MS,
    ).first()) !== null;
  if ((!flagged && !repeat) || !staff || staff.authEpoch === undefined)
    throw new ConflictError('Your PIN does not need replacing.', 'STAFF_PIN_RESET_NOT_REQUIRED');
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
        },
        repeat,
      );
      break;
    } catch (error) {
      if (attempt < 2 && classifyD1Error(error)?.kind === 'unique') continue;
      throw error;
    }
  }
  await auditStmt(db, ctx, {
    orgId,
    actorType: 'scanner',
    actorId: scanner.id,
    action: 'scan_staff.pin_self_reset',
    targetType: 'scan_staff',
    targetId: staff.id,
  }).run();
  return { pin, session: await staffSession(ctx, actor) };
}
