import { StaffDeviceFieldsSchema } from '../../../shared/contracts/scan-device.ts';
import { ValidationError } from '../../platform/errors.ts';

const STAFF_FIELDS = Object.keys(StaffDeviceFieldsSchema.shape);

/** Until Staff devices carry their own settings (SD2, SD3), these are refused, never dropped. */
export function refuseStaffFields(input: Record<string, unknown>): void {
  if (STAFF_FIELDS.some((key) => input[key] !== undefined))
    throw new ValidationError(
      'Owner, sign-in ceiling, alerts and coverage are not available yet.',
      [],
      'STAFF_DEVICE_FIELDS_UNAVAILABLE',
    );
}

/** The kind never changes: a layout is for a Staff device. */
export function refuseScreenLayout(
  role: 'scan' | 'monitor' | 'customer',
  input: { surface?: unknown },
): void {
  if (role !== 'scan' && input.surface !== undefined)
    throw new ValidationError(
      'A screen has no layout. The kind of device cannot change.',
      [],
      'DEVICE_KIND_FIXED',
    );
}
