import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScannerRow, touchStaff, unbindStaff } from './repo-device.ts';
import type { ScanStaffRow } from './repo-staff.ts';

export const STAFF_IDLE_MS = 15 * 60_000;
export const STAFF_MAX_MS = 12 * 3_600_000;
export const STAFF_TOUCH_EVERY_MS = 60_000;

export interface BoundStaff {
  id: string;
  name: string;
  role: ScanRole;
  /** Monotonic staff revision, used to fence authorizations against changes. */
  updatedAt: number;
}

/** True when a signed-in person's binding ran out: 15 minutes idle or 12 hours. */
export const bindingExpired = (scanner: ScannerRow, now: number): boolean =>
  now - (scanner.staffSeenAt ?? 0) > STAFF_IDLE_MS ||
  now - (scanner.staffSince ?? 0) > STAFF_MAX_MS;

/**
 * The staff member signed in on a scanner, or null. `staff` is the row read for `scanner.staffId`
 * (null when none was read because the binding expired). Ends the binding when it expired or the
 * person was disabled or removed. Activity is recorded at most once a minute.
 */
export async function boundStaff(
  ctx: ServiceContext,
  scanner: ScannerRow,
  staff: ScanStaffRow | null,
): Promise<BoundStaff | null> {
  if (!scanner.staffId) return null;
  const now = ctx.clock.now();
  if (
    !staff ||
    staff.id !== scanner.staffId ||
    staff.orgId !== scanner.orgId ||
    staff.disabledAt !== null ||
    bindingExpired(scanner, now)
  ) {
    await unbindStaff(ctx, scanner);
    return null;
  }
  if ((scanner.staffSeenAt ?? 0) <= now - STAFF_TOUCH_EVERY_MS)
    await touchStaff(ctx.env.DB, scanner, now, STAFF_TOUCH_EVERY_MS);
  return { id: staff.id, name: staff.name, role: staff.role, updatedAt: staff.updatedAt };
}
