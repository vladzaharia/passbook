import { bump, read } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { namedDayKey, orgDayKey } from './repo-pin-tag.ts';

/**
 * Wrong PINs for one named person per day, across every paired device and every window. The 5 in
 * 5 minutes and 30 an hour limits bound a burst; this bounds the sustained rate against one account.
 */
export const PIN_MISSES_PER_STAFF_DAY = 50;
/** And across the whole org, so a fleet of devices cannot lock out everyone: past it, named sign-in answers as a lockout. */
export const PIN_NAMED_MISSES_PER_ORG_DAY = 300;
const DAY = 24 * 3_600_000;

export const dayWindowOf = (now: number) => now - (now % DAY);

/** Refuse a named sign-in or approval once the person's day, or the org's, is spent. Nothing is checked. */
export async function guardNamedDay(
  ctx: ServiceContext,
  orgId: string,
  staffId: string,
): Promise<void> {
  const now = ctx.clock.now();
  const window = dayWindowOf(now);
  const [person, org] = await Promise.all([
    read(ctx.env.DB, namedDayKey(staffId), window),
    read(ctx.env.DB, orgDayKey(orgId), window),
  ]);
  if (person >= PIN_MISSES_PER_STAFF_DAY || org >= PIN_NAMED_MISSES_PER_ORG_DAY)
    throw new AppError('RATE_LIMITED', 429, 'Too many wrong PINs. Try again later.', {
      headers: { 'retry-after': String(Math.ceil((window + DAY - now) / 1000)) },
      issues: [{ path: 'pin', message: 'locked' }],
    });
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
  const [person, org] = await Promise.all([
    bump(db, namedDayKey(staffId), window),
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
  if (org === PIN_NAMED_MISSES_PER_ORG_DAY) {
    await entry('scan.pin_named_org_cap', 'org', orgId).run();
    ctx.log.error('scan.pin_named_org_cap', { orgId, scannerId, code: 'PIN_NAMED_ORG_CAP' });
  }
}
