import { safeEqual } from '../../platform/ids.ts';
import type { ScanStaffRow } from './repo-staff.ts';
import type { PinStaffSnapshot } from './staff-pin-snapshot.ts';

export const DUMMY_PIN_HASH = '0'.repeat(64);

/** What the reservation is counted against, and the key the PINs are hashed under. */
interface Subject {
  pinEnv: object;
  orgId: string;
  staffId: string;
}

type Candidate = Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> &
  Partial<Pick<ScanStaffRow, 'id' | 'role'>>;

/** One person: the PIN is theirs, and they are usable (and a manager when only a manager will do). */
export const personDecision =
  (
    { pinEnv, orgId, staffId }: Subject,
    staff: Candidate | null,
    pin: string,
    managerOnly: boolean,
    hash: (env: object, id: string, pin: string) => Promise<string>,
  ) =>
  async (): Promise<'match' | 'miss'> => {
    const usable =
      staff?.orgId === orgId &&
      staff.disabledAt === null &&
      (!managerOnly || (staff.id === staffId && staff.role === 'manager'));
    const matches = await safeEqual(
      await hash(pinEnv, staffId, pin),
      usable ? staff.pinHash : DUMMY_PIN_HASH,
    );
    return usable && matches ? 'match' : 'miss';
  };

/**
 * No one is named: the PIN is matched against every manager (all are hashed, so the time does not
 * say which matched). Exactly one match verifies; two are `ambiguous`, which counts as a miss.
 */
export function anyManagerDecision(
  { pinEnv, orgId, staffId }: Subject,
  managers: readonly PinStaffSnapshot[],
  pin: string,
  hash: (env: object, id: string, pin: string) => Promise<string>,
) {
  let found: PinStaffSnapshot | null = null;
  let count = 0;
  return {
    async decide(): Promise<'match' | 'miss' | 'ambiguous'> {
      for (const manager of managers) {
        const usable =
          manager.orgId === orgId && manager.disabledAt === null && manager.role === 'manager';
        if (usable && (await safeEqual(await hash(pinEnv, manager.id, pin), manager.pinHash))) {
          found = manager;
          count++;
        }
      }
      await safeEqual(await hash(pinEnv, staffId, pin), DUMMY_PIN_HASH);
      return count === 1 ? 'match' : count > 1 ? 'ambiguous' : 'miss';
    },
    found: () => found,
  };
}
