import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { mailPinOnlyOff } from './pin-only-notice.ts';
import type { ScannerRow } from './repo-device.ts';
import {
  budgetStatements,
  pinOnlyGateStatements,
  pinOnlyIsOff,
  pinOnlyLockoutStatement,
  spentDays,
} from './repo-pin-only.ts';
import { flagPinReset, pinStateGrant } from './repo-pin-tag.ts';
import { pinOnlyCandidatesStatement } from './repo-staff.ts';
import {
  ANY_STAFF,
  pinStaffListFromResult,
  preparePinReservation,
  type VerifiedPinSnapshot,
} from './staff-pin.ts';
import { pinOnlyDecision } from './staff-pin-decide.ts';
import { pinMatcher, pinTag } from './staff-pin-hash.ts';

/** Past this many active staff a PIN alone is not accepted: a name is asked for. */
export const PIN_ONLY_MAX_STAFF = 100;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
/**
 * A guess can hit any of the N active staff, so each wrong PIN costs the org about N guesses. The
 * budgets keep N times the misses near a constant: org-wide wrong PINs an hour, and a day. At the
 * most staff allowed that is 1 an hour and 4 a day; the worst sustained chance a PIN falls is about
 * 0.3% a week and 1.2% a month, in line with name + PIN on one device.
 */
export const pinOnlyHourlyCap = (staff: number) =>
  clamp(Math.floor(150 / Math.max(1, staff)), 1, 15);
export const pinOnlyDailyCap = (staff: number) =>
  clamp(Math.floor(400 / Math.max(1, staff)), 4, 40);
/** Daily budgets spent on this many days of 7 turn PIN-only off for the org until an admin turns it on. */
export const PIN_ONLY_LOCKOUT_DAYS = 3;

const nameRequired = () =>
  new AppError('STAFF_NAME_REQUIRED', 409, 'Pick your name, then enter your PIN.');

const countOf = (result: D1Result | undefined) =>
  (result?.results?.[0] as { count?: number } | undefined)?.count;

/** Audit rows, logs and the lockout for a wrong PIN, written once the miss is known. */
async function recordMiss(
  ctx: ServiceContext,
  scanner: ScannerRow,
  counts: { hour: number | undefined; day: number | undefined },
  caps: { hour: number; day: number },
  matched: readonly { id: string; role: string }[],
) {
  const db = ctx.env.DB;
  const { orgId } = scanner;
  const scannerId = scanner.id;
  const entry = (action: string, targetType: string, targetId: string) =>
    auditStmt(db, ctx, {
      orgId,
      actorType: 'scanner',
      actorId: scannerId,
      action,
      targetType,
      targetId,
    });
  const audits: D1PreparedStatement[] = [];
  // A shared PIN and a Manager's PIN answer as a wrong one; the audit is how an admin finds them.
  if (matched.length > 1)
    for (const person of matched)
      audits.push(entry('scan_staff.pin_shared', 'scan_staff', person.id));
  else if (matched[0]?.role === 'manager')
    audits.push(entry('scan_staff.pin_only_manager', 'scan_staff', matched[0].id));
  const hourSpent = counts.hour === caps.hour;
  const daySpent = counts.day === caps.day;
  if (hourSpent) {
    audits.push(entry('scanner.pin_only_paused', 'scanner', scannerId));
    ctx.log.warn('scan.pin_only_paused', { orgId, scannerId, code: 'PIN_ONLY_PAUSED' });
  }
  if (daySpent) {
    audits.push(entry('scanner.pin_only_daily_limit', 'scanner', scannerId));
    ctx.log.error('scan.pin_only_daily_limit', { orgId, scannerId, code: 'PIN_ONLY_DAILY_LIMIT' });
  }
  if (!audits.length) return;
  if (matched.length > 1) {
    // Both people sign in only after an admin resets their PINs.
    const g = pinStateGrant(ctx, scanner);
    for (const person of matched) flagPinReset(g, person.id);
    await g.commit();
  }
  await db.batch(audits);
  if (!daySpent) return;
  const now = ctx.clock.now();
  const spent = await spentDays(db, orgId, now);
  if ((spent?.days ?? 0) < PIN_ONLY_LOCKOUT_DAYS) return;
  await db.batch([
    pinOnlyLockoutStatement(db, orgId, now),
    entry('scan.pin_only_off', 'org', orgId),
  ]);
  ctx.log.error('scan.pin_only_off', { orgId, scannerId, code: 'PIN_ONLY_OFF' });
  await mailPinOnlyOff(ctx, orgId);
}

/**
 * The one active Door or Desk member who has this PIN. The device's counters are the reservation's
 * (a miss costs the device as it does with a name); the org budget is reserved first and kept for
 * every miss. A shared PIN, a Manager's PIN and an unknown PIN are all the same wrong PIN.
 */
export async function checkPinOnly(
  ctx: ServiceContext,
  scanner: ScannerRow,
  pin: string,
): Promise<VerifiedPinSnapshot> {
  const db = ctx.env.DB;
  const { orgId } = scanner;
  const scannerId = scanner.id;
  const [lock, setting, total] = await db.batch(pinOnlyGateStatements(db, orgId));
  const staff = countOf(total) ?? 0;
  if ((lock && setting && pinOnlyIsOff(lock, setting)) || staff > PIN_ONLY_MAX_STAFF)
    throw nameRequired();
  const budget = budgetStatements(ctx, orgId, {
    hour: pinOnlyHourlyCap(staff),
    day: pinOnlyDailyCap(staff),
  });
  const [hourResult, dayResult] = await db.batch(budget.reserve);
  const counts = { day: countOf(dayResult), hour: countOf(hourResult) };
  if (counts.day === undefined || counts.hour === undefined) {
    // One counter took a slot the other refused: give it back.
    if (counts.hour !== undefined) await db.batch([budget.release('hour')]);
    if (counts.day !== undefined) await db.batch([budget.release('day')]);
    ctx.log.warn('scan.pin_only_paused', { orgId, scannerId, code: 'PIN_ONLY_PAUSED' });
    throw nameRequired();
  }
  const refundBudget = () => db.batch(budget.refund());
  const reservation = preparePinReservation(ctx, { scannerId, orgId, staffId: ANY_STAFF });
  try {
    const tag = await pinTag(ctx.env, orgId, pin);
    const results = await db.batch([
      pinOnlyCandidatesStatement(db, orgId, tag),
      ...reservation.stmts,
    ]);
    const keyEnv = captureCredentialKeyEnv(ctx.env);
    const only = pinOnlyDecision(
      { pinEnv: keyEnv, orgId, staffId: ANY_STAFF },
      pinStaffListFromResult(results[0]),
      pin,
      await pinMatcher(keyEnv),
    );
    try {
      const verified = await reservation.verifyOnly(results.slice(1), only);
      if (!verified) throw new Error('PIN matched no staff snapshot');
      await refundBudget();
      return verified;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PIN_INVALID')
        // Deferred on every miss, so an audit for a shared or Manager PIN cannot make that answer slower.
        ctx.waitUntil(
          recordMiss(
            ctx,
            scanner,
            counts as { hour: number; day: number },
            { hour: budget.hour.cap, day: budget.day.cap },
            only.matched(),
          ).catch((cause: unknown) =>
            ctx.log.error('scan.pin_only_audit_failed', {
              orgId,
              code: 'PIN_ONLY_AUDIT',
              error: cause,
            }),
          ),
        );
      // A device lockout is not a guess, so the org does not pay for it.
      else if (error instanceof AppError && error.code === 'RATE_LIMITED') await refundBudget();
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
