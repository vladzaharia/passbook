import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { type ScanStaffRow, type StaffRaw, toStaff } from './repo-staff.ts';

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

export interface PinSubject {
  scannerId: string;
  orgId: string;
  staffId: string;
  /** With no one named: how many managers the PIN is tested against; each attempt costs that many guesses. */
  testedManagers?: number;
}

export interface PinCheck extends PinSubject {
  /** The caller's org-scoped snapshot, including null for an unknown or unusable person. */
  staff: Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> | null;
  pin: string;
}

export type PinFailure = {
  failureStatements: D1PreparedStatement[];
  onFailureCommitted(): void;
};

export interface PinReservation {
  readonly stmts: D1PreparedStatement[];
  verify(
    results: readonly D1Result[],
    staff: PinStaffSnapshot | null,
    pin: string,
    managerOnly: boolean,
    failure?: PinFailure,
  ): Promise<VerifiedPinSnapshot | null>;
  /** The PIN of whichever manager has it: none, one, or several (a miss). */
  verifyAny(
    results: readonly D1Result[],
    managers: readonly PinStaffSnapshot[],
    pin: string,
    failure?: PinFailure,
  ): Promise<VerifiedPinSnapshot | null>;
  verifyLogin(results: readonly D1Result[], staff: PinCheck['staff'], pin: string): Promise<void>;
  refundStatements(): D1PreparedStatement[];
  markRefunded(): void;
  refund(failure?: PinFailure): Promise<void>;
}
