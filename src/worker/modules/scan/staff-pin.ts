import type { ScanRole } from '../../../shared/contracts/scan.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { safeEqual, toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { type ScanStaffRow, type StaffRaw, toStaff } from './repo-staff.ts';
import { preparePinCounters } from './repo-staff-pin-counters.ts';

const MINUTE = 60_000;
export const PIN_MISSES_PER_PERSON = 5;
export const PIN_PERSON_WINDOW_MS = 5 * MINUTE;
export const PIN_MISSES_PER_SCANNER = 20;
export const PIN_SCANNER_WINDOW_MS = 60 * MINUTE;
const DUMMY_PIN_HASH = '0'.repeat(64);
const windowOf = (now: number, size: number) => now - (now % size);

/** HMAC-SHA256(K_pin, id:pin), hex. A database leak alone cannot be brute-forced offline. */
export async function hashPin(env: object, staffId: string, pin: string): Promise<string> {
  const key = await derivedHmacKey(env, 'scan-pin');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${staffId}:${pin}`));
  return toHex(new Uint8Array(mac));
}

export interface PinSubject {
  scannerId: string;
  orgId: string;
  staffId: string;
}

export interface PinCheck extends PinSubject {
  /** The caller's org-scoped snapshot, including null for an unknown or unusable person. */
  staff: Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> | null;
  pin: string;
}

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

function hideHash<T extends object>(value: T, pinHash: string): Readonly<T & { pinHash: string }> {
  Object.defineProperty(value, 'pinHash', { value: pinHash, enumerable: false });
  return Object.freeze(value) as Readonly<T & { pinHash: string }>;
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

export type PinReservationGuard = { sql: string; params: readonly SqlValue[] };
const lockedError = (millisecondsLeft: number) =>
  new RateLimitedError(Math.ceil(millisecondsLeft / 1000), 'Too many wrong PINs. Try again later.');
const resultCount = (result: D1Result | undefined) =>
  (result?.results?.[0] as { count?: number } | undefined)?.count;
type PinFailure = {
  failureStatements: D1PreparedStatement[];
  onFailureCommitted(): void;
};
type PinCandidate = Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> &
  Partial<Pick<ScanStaffRow, 'id' | 'role'>>;

export interface PinReservation {
  readonly stmts: D1PreparedStatement[];
  verify(
    results: readonly D1Result[],
    staff: PinStaffSnapshot | null,
    pin: string,
    managerOnly: boolean,
    failure?: PinFailure,
  ): Promise<VerifiedPinSnapshot | null>;
  verifyLogin(results: readonly D1Result[], staff: PinCheck['staff'], pin: string): Promise<void>;
  refundStatements(): D1PreparedStatement[];
  markRefunded(): void;
  refund(failure?: PinFailure): Promise<void>;
}

/**
 * A reservation is serialized in D1 with both fixed-window counters. A private counter marker
 * records its state, so cleanup remains exactly-once even if a committed batch's response is lost.
 * The caller's predicate must be stable throughout these statements, and bind the original actor,
 * CSRF/keyset authority and owned action claim where applicable; it must not depend on changes().
 */
export function preparePinReservation(
  ctx: ServiceContext,
  subject: PinSubject,
  guard: PinReservationGuard = { sql: '1', params: [] },
): PinReservation {
  const db = ctx.env.DB;
  const pinEnv = captureCredentialKeyEnv(ctx.env);
  const auditContext = { clock: ctx.clock, requestId: ctx.requestId };
  const { scannerId, staffId, orgId } = subject;
  const now = ctx.clock.now();
  const personWindow = windowOf(now, PIN_PERSON_WINDOW_MS);
  const allWindow = windowOf(now, PIN_SCANNER_WINDOW_MS);
  const personKey = `scan:pin:${scannerId}:${staffId}`;
  const allKey = `scan:pinall:${scannerId}`;
  const markerKey = `scan:pin-reservation:${ctx.ids.token()}`;
  const counters = preparePinCounters(db, {
    guard,
    markerKey,
    personKey,
    personWindow,
    personCap: PIN_MISSES_PER_PERSON,
    allKey,
    allWindow,
    scannerCap: PIN_MISSES_PER_SCANNER,
  });
  const stmts = counters.stmts;
  let used = false;
  let verified = false;
  let settled = false;

  const commitBatch = async (statements: D1PreparedStatement[]) => {
    const results = await db.batch(statements);
    if (results.length !== statements.length) throw new Error('Incomplete PIN cleanup results');
    for (let index = 0; index < statements.length; index++) {
      if (results[index]?.success !== true) throw new Error('Incomplete PIN cleanup results');
    }
  };

  const refundStatements = (): D1PreparedStatement[] =>
    settled ? [] : counters.refundStatements();

  const verifyCandidate = async (
    results: readonly D1Result[],
    staff: PinCandidate | null,
    pin: string,
    managerOnly: boolean,
    failure?: PinFailure,
  ): Promise<boolean> => {
    if (used) throw new Error('A PIN reservation can only be checked once');
    used = true;
    if (results.length !== stmts.length) throw new Error('Incomplete PIN reservation results');
    for (let index = 0; index < stmts.length; index++) {
      const result = results[index];
      if (result?.success !== true || !Array.isArray(result.results))
        throw new Error('Incomplete PIN reservation results');
      const count = resultCount(result);
      if (
        result.results.length > 1 ||
        result.meta?.changes !== result.results.length ||
        (result.results.length === 1 &&
          (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0))
      )
        throw new Error('Incomplete PIN reservation results');
    }
    const shape = (...lengths: number[]) =>
      results.every((result, index) => result.results.length === lengths[index]);
    const finishFailure = async (audits: D1PreparedStatement[]) => {
      const statements = [...audits, ...(failure?.failureStatements ?? [])];
      if (!statements.length) return;
      await commitBatch(statements);
      failure?.onFailureCommitted();
    };
    const initial = resultCount(results[0]);
    if (initial === undefined) {
      if (!shape(0, 0, 0, 0, 0, 0, 0)) throw new Error('Inconsistent PIN reservation results');
      // A complete, unchanged batch created no marker and has nothing to release.
      settled = true;
      return false;
    }
    if (initial !== 1) throw new Error('Invalid PIN reservation marker');
    const person = resultCount(results[1]);
    if (person === undefined) {
      if (!shape(1, 0, 0, 0, 0, 0, 0)) throw new Error('Inconsistent PIN person lock');
      settled = true;
      await finishFailure([]);
      throw lockedError(personWindow + PIN_PERSON_WINDOW_MS - now);
    }
    if (person < 1 || person > PIN_MISSES_PER_PERSON || resultCount(results[2]) !== 2)
      throw new Error('Incomplete PIN person reservation');
    const scanner = resultCount(results[3]);
    if (scanner === undefined) {
      if (
        !shape(1, 1, 1, 0, 0, 1, 1) ||
        resultCount(results[5]) !== person - 1 ||
        resultCount(results[6]) !== 3
      )
        throw new Error('Incomplete PIN scanner compensation');
      settled = true;
      await finishFailure([]);
      throw lockedError(allWindow + PIN_SCANNER_WINDOW_MS - now);
    }
    if (
      scanner < 1 ||
      scanner > PIN_MISSES_PER_SCANNER ||
      !shape(1, 1, 1, 1, 1, 0, 0) ||
      resultCount(results[4]) !== 4
    )
      throw new Error('Incomplete PIN scanner reservation');

    const usable =
      staff?.orgId === orgId &&
      staff.disabledAt === null &&
      (!managerOnly || (staff.id === staffId && staff.role === 'manager'));
    const expected = await hashPin(pinEnv, staffId, pin);
    const matches = await safeEqual(expected, usable ? staff.pinHash : DUMMY_PIN_HASH);
    if (usable && matches) {
      verified = true;
      return true;
    }

    // A miss keeps both reservations, including if the audit subsequently fails.
    settled = true;
    const audits: D1PreparedStatement[] = [];
    if (person === PIN_MISSES_PER_PERSON)
      audits.push(
        auditStmt(db, auditContext, {
          orgId,
          actorType: 'scanner',
          actorId: scannerId,
          action: 'scan_staff.pin_locked',
          targetType: 'scan_staff',
          targetId: staffId,
        }),
      );
    if (scanner === PIN_MISSES_PER_SCANNER)
      audits.push(
        auditStmt(db, auditContext, {
          orgId,
          actorType: 'scanner',
          actorId: scannerId,
          action: 'scanner.pin_flood',
          targetType: 'scanner',
          targetId: scannerId,
        }),
      );
    await finishFailure(audits);
    const triesLeft = Math.max(0, PIN_MISSES_PER_PERSON - person);
    throw new AppError(
      'PIN_INVALID',
      400,
      triesLeft > 0 ? `Wrong PIN. ${triesLeft} tries left.` : 'Wrong PIN. Try again later.',
      { issues: [{ path: 'triesLeft', message: String(triesLeft) }] },
    );
  };

  return {
    stmts,
    async verify(results, staff, pin, managerOnly, failure) {
      // The proof returned to the caller is exactly the immutable row we verified.
      const captured =
        resultCount(results[0]) === undefined
          ? null
          : staff &&
            hideHash(
              {
                id: staff.id,
                orgId: staff.orgId,
                role: staff.role,
                disabledAt: staff.disabledAt,
                updatedAt: staff.updatedAt,
                authEpoch: staff.authEpoch,
              },
              staff.pinHash,
            );
      if (!(await verifyCandidate(results, captured, pin, managerOnly, failure))) return null;
      if (!captured) throw new Error('Verified PIN has no staff snapshot');
      return captured;
    },
    async verifyLogin(results, staff, pin) {
      if (!(await verifyCandidate(results, staff, pin, false)))
        throw new Error('PIN reservation was not authorized');
    },
    refundStatements() {
      if (settled) return [];
      if (!verified) throw new Error('Cannot prepare a refund before verifying the PIN');
      return refundStatements();
    },
    markRefunded() {
      if (!verified) throw new Error('Cannot mark an unverified PIN as refunded');
      settled = true;
    },
    async refund(failure) {
      const refunds = refundStatements();
      const statements = failure ? [...refunds, ...failure.failureStatements] : refunds;
      if (!statements.length) return;
      await commitBatch(statements);
      settled = true;
      failure?.onFailureCommitted();
    },
  };
}

/** Check the login caller's captured row using the same atomic reservation machinery. */
export async function checkPin(ctx: ServiceContext, check: PinCheck): Promise<void> {
  const db = ctx.env.DB;
  const pin = check.pin;
  const staff = check.staff
    ? hideHash(
        { orgId: check.staff.orgId, disabledAt: check.staff.disabledAt },
        check.staff.pinHash,
      )
    : null;
  const reservation = preparePinReservation(ctx, check);
  try {
    const results = await db.batch(reservation.stmts);
    await reservation.verifyLogin(results, staff, pin);
  } finally {
    // A failed refund must not fail a verified sign-in; the attempt stays counted.
    await reservation
      .refund()
      .catch((error: unknown) =>
        ctx.log.error('scan.pin_refund_failed', { code: 'PIN_REFUND', error }),
      );
  }
}
