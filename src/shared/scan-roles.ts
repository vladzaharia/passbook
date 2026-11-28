import type { z } from 'zod';
import type { DeviceRoleSchema } from './contracts/scanners.ts';

type DeviceRole = z.infer<typeof DeviceRoleSchema>;

/** A device that only shows (customer screen, monitor). `!== 'scan'` is not this: a kiosk is neither. */
export const isScreenRole = (role: DeviceRole): role is 'customer' | 'monitor' =>
  role === 'customer' || role === 'monitor';
/** A Staff device: the only role that trusts the signed-in person with a staff `ScanResult`. */
export const isStaffDeviceRole = (role: DeviceRole): role is 'scan' => role === 'scan';
/** An unattended guest device. It scans, but never as staff. */
export const isKioskRole = (role: DeviceRole): role is 'kiosk' => role === 'kiosk';
