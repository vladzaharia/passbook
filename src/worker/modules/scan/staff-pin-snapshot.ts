import type { ScanRole } from '../../../shared/contracts/scan.ts';
import type { GrantPart } from '../../platform/authority-include.ts';
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
/** The person a sign-in PIN is counted against when it names no one; the counters are per device. */
export const ANY_STAFF = '*staff';

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
    deskOk?: boolean,
  ): Promise<VerifiedPinSnapshot | null>;
  /** The PIN of whichever manager has it: none, one, or several (a miss). */
  verifyAny(
    results: readonly D1Result[],
    managers: readonly PinStaffSnapshot[],
    pin: string,
    failure?: PinFailure,
    anyRole?: boolean,
    deskOk?: boolean,
  ): Promise<VerifiedPinSnapshot | null>;
  /** Sign-in with no name: the one active staff member who has the PIN. Several answer `STAFF_PIN_AMBIGUOUS`. */
  verifyOnly(
    results: readonly D1Result[],
    roster: readonly PinStaffSnapshot[],
    pin: string,
  ): Promise<VerifiedPinSnapshot | null>;
  verifyLogin(results: readonly D1Result[], staff: PinCheck['staff'], pin: string): Promise<void>;
  refundStatements(): D1PreparedStatement[];
  /** The refund as parts of the scan's own grant batch; `markRefunded` once it commits. */
  refundParts(): GrantPart[];
  markRefunded(): void;
  refund(failure?: PinFailure): Promise<void>;
}
