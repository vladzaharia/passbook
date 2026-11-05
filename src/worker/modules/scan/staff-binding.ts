import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type ScannerRow, touchStaff, unbindStaff } from './repo-device.ts';
import { getStaff } from './repo-staff.ts';

export const STAFF_IDLE_MS = 15 * 60_000;
export const STAFF_MAX_MS = 12 * 3_600_000;
const TOUCH_EVERY_MS = 60_000;

export interface BoundStaff {
  id: string;
  name: string;
  role: ScanRole;
}

/**
 * The staff member signed in on a scanner, or null. Ends the binding at 15 minutes idle, 12 hours,
 * or when the person was disabled or removed. Activity is recorded at most once a minute.
 */
export async function boundStaff(
  ctx: ServiceContext,
  scanner: ScannerRow,
): Promise<BoundStaff | null> {
  if (!scanner.staffId) return null;
  const now = ctx.clock.now();
  const expired =
    now - (scanner.staffSeenAt ?? 0) > STAFF_IDLE_MS ||
    now - (scanner.staffSince ?? 0) > STAFF_MAX_MS;
  const staff = expired ? null : await getStaff(ctx.env.DB, scanner.orgId, scanner.staffId);
  if (!staff || staff.disabledAt !== null) {
    await unbindStaff(ctx.env.DB, scanner.id);
    return null;
  }
  await touchStaff(ctx.env.DB, scanner.id, now, TOUCH_EVERY_MS);
  return { id: staff.id, name: staff.name, role: staff.role };
}
