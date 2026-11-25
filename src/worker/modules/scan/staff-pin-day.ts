import { bump } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { mailPinOrgCap } from './pin-only-notice.ts';
import { deviceDayKey, namedDayCountsStatement, namedDayKey, orgDayKey } from './repo-pin-tag.ts';

/**
 * Wrong PINs for one named person per day, across every paired device and every window. The 5 in
 * 5 minutes and 30 an hour limits bound a burst; this bounds the sustained rate against one account.
 */
export const PIN_MISSES_PER_STAFF_DAY = 50;
/** One paired device's wrong named PINs per day: the device that spent it is refused, others are not. */
export const PIN_NAMED_MISSES_PER_DEVICE_DAY = 100;
/** The org's wrong named PINs per day: it only raises an alert (mail to admins), it never refuses a PIN. */
export const PIN_NAMED_MISSES_ALERT_ORG_DAY = 300;
const DAY = 24 * 3_600_000;

/**
 * The fixed 24-hour window the wrong-PIN counters run on. It is a rate-limit epoch, not a calendar
 * day: an org zone would make it 23 or 25 hours twice a year and cost a zone read per attempt.
 */
export const dayWindowOf = (now: number) => now - (now % DAY);

const lockedError = (window: number, now: number) =>
  new AppError('RATE_LIMITED', 429, 'Too many wrong PINs. Try again later.', {
    headers: { 'retry-after': String(Math.ceil((window + DAY - now) / 1000)) },
    issues: [{ path: 'pin', message: 'locked' }],
  });

/** Whether a day-counter read (see `namedDayCountsStatement`) shows the person's or the device's day spent. */
export function assertNamedDayRows(
  ctx: ServiceContext,
  rows: readonly { key: string; count: number }[],
  scannerId: string,
  staffId: string,
): void {
  const count = (key: string) => rows.find((r) => r.key === key)?.count ?? 0;
  if (
    count(namedDayKey(staffId)) >= PIN_MISSES_PER_STAFF_DAY ||
    count(deviceDayKey(scannerId)) >= PIN_NAMED_MISSES_PER_DEVICE_DAY
  ) {
    const now = ctx.clock.now();
    throw lockedError(dayWindowOf(now), now);
  }
}

/** Refuse a named sign-in once the person's day, or this device's, is spent. Nothing is checked. */
export async function guardNamedDay(
  ctx: ServiceContext,
  scannerId: string,
  staffId: string,
): Promise<void> {
  const now = ctx.clock.now();
  const rows = await namedDayCountsStatement(ctx.env.DB, staffId, scannerId, dayWindowOf(now)).all<{
    key: string;
    count: number;
  }>();
  assertNamedDayRows(ctx, rows.results, scannerId, staffId);
}

/** Count a wrong PIN against the person it named and the org; the miss that spends either is audited. */
export async function countNamedMiss(
  ctx: ServiceContext,
  scope: { orgId: string; scannerId: string; staffId: string },
  error: unknown,
): Promise<void> {
  if (!(error instanceof AppError) || error.code !== 'PIN_INVALID') return;
  const { orgId, scannerId, staffId } = scope;
  const db = ctx.env.DB;
  const window = dayWindowOf(ctx.clock.now());
  const [person, , org] = await Promise.all([
    bump(db, namedDayKey(staffId), window),
    bump(db, deviceDayKey(scannerId), window),
    bump(db, orgDayKey(orgId), window),
  ]);
  const entry = (action: string, targetType: string, targetId: string) =>
    auditStmt(db, ctx, {
      orgId,
      actorType: 'scanner',
      actorId: scannerId,
      action,
      targetType,
      targetId,
    });
  if (person === PIN_MISSES_PER_STAFF_DAY) {
    await entry('scan_staff.pin_day_limit', 'scan_staff', staffId).run();
    ctx.log.warn('scan.pin_day_limit', { orgId, scannerId, code: 'PIN_DAY_LIMIT' });
  }
  if (org === PIN_NAMED_MISSES_ALERT_ORG_DAY) {
    await entry('scan.pin_named_org_cap', 'org', orgId).run();
    ctx.log.error('scan.pin_named_org_cap', { orgId, scannerId, code: 'PIN_NAMED_ORG_CAP' });
    // After the answer: the 300th wrong PIN is still a wrong PIN if the mail path fails.
    ctx.waitUntil(
      mailPinOrgCap(ctx, orgId).catch((error: unknown) =>
        ctx.log.error('scan.pin_org_cap_mail_failed', { orgId, code: 'PIN_ORG_CAP_MAIL', error }),
      ),
    );
  }
}
