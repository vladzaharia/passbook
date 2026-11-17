import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { type StaffRaw, toStaff } from './repo-staff.ts';

export type PinStaffSnapshot = Readonly<{
  id: string;
  orgId: string;
  role: ScanRole;
  disabledAt: number | null;
  updatedAt: number;
  /** From the row the PIN was verified against (the approver's epoch). */
  authEpoch: number;
  pinHash: string;
}>;
export type VerifiedPinSnapshot = PinStaffSnapshot;

export function hideHash<T extends object>(
  value: T,
  pinHash: string,
): Readonly<T & { pinHash: string }> {
  Object.defineProperty(value, 'pinHash', { value: pinHash, enumerable: false });
  return Object.freeze(value) as Readonly<T & { pinHash: string }>;
}

/** The person a PIN is counted against when it names no one. */
export const ANY_MANAGER = '*';

export function pinStaffListFromResult(result: D1Result | undefined): PinStaffSnapshot[] {
  return (result?.results ?? []).flatMap((raw) => {
    const staff = toStaff(raw as StaffRaw);
    return [
      hideHash(
        {
          id: staff.id,
          orgId: staff.orgId,
          role: staff.role,
          disabledAt: staff.disabledAt,
          updatedAt: staff.updatedAt,
          authEpoch: (raw as StaffRaw).auth_epoch,
        },
        staff.pinHash,
      ),
    ];
  });
}

export function pinStaffFromResult(result: D1Result | undefined): PinStaffSnapshot | null {
  const raw = result?.results?.[0] as StaffRaw | undefined;
  if (!raw) return null;
  const staff = toStaff(raw);
  return hideHash(
    {
      id: staff.id,
      orgId: staff.orgId,
      role: staff.role,
      disabledAt: staff.disabledAt,
      updatedAt: staff.updatedAt,
      authEpoch: raw.auth_epoch,
    },
    staff.pinHash,
  );
}
