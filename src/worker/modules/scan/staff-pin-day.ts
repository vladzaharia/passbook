import { bump, read } from '../../platform/counters.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';

/**
 * Wrong PINs for one named person per day, across every paired device and every window. The 5 in
 * 5 minutes and 30 an hour limits bound a burst; this bounds the sustained rate against one account.
 */
export const PIN_MISSES_PER_STAFF_DAY = 50;
const DAY = 24 * 3_600_000;

const keyOf = (staffId: string) => `scan:pinday:${staffId}`;
const windowOf = (now: number) => now - (now % DAY);

/** Refuse a named sign-in once the person's day is spent. Costs no guess: nothing is checked. */
export async function guardNamedDay(ctx: ServiceContext, staffId: string): Promise<void> {
  const now = ctx.clock.now();
  const window = windowOf(now);
  if ((await read(ctx.env.DB, keyOf(staffId), window)) >= PIN_MISSES_PER_STAFF_DAY)
    throw new AppError('RATE_LIMITED', 429, 'Too many wrong PINs. Try again later.', {
      headers: { 'retry-after': String(Math.ceil((window + DAY - now) / 1000)) },
      issues: [{ path: 'pin', message: 'locked' }],
    });
}

/** Count a wrong PIN against the person it named; the miss that spends the day is audited. */
export async function countNamedMiss(
  ctx: ServiceContext,
  scope: { orgId: string; scannerId: string; staffId: string },
  error: unknown,
): Promise<void> {
  if (!(error instanceof AppError) || error.code !== 'PIN_INVALID') return;
  const { orgId, scannerId, staffId } = scope;
  const db = ctx.env.DB;
  const count = await bump(db, keyOf(staffId), windowOf(ctx.clock.now()));
  if (count !== PIN_MISSES_PER_STAFF_DAY) return;
  await auditStmt(db, ctx, {
    orgId,
    actorType: 'scanner',
    actorId: scannerId,
    action: 'scan_staff.pin_day_limit',
    targetType: 'scan_staff',
    targetId: staffId,
  }).run();
  ctx.log.warn('scan.pin_day_limit', { orgId, scannerId, code: 'PIN_DAY_LIMIT' });
}
