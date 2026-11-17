import { derivedHmacKey } from '../../platform/crypto.ts';
import type { SqlValue } from '../../platform/db.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import { captureCredentialKeyEnv } from '../passes/credential-keyset.ts';
import { preparePinCounters } from './repo-staff-pin-counters.ts';
import { anyManagerDecision, personDecision } from './staff-pin-decide.ts';
import {
  ANY_MANAGER,
  hideHash,
  type PinCheck,
  type PinFailure,
  type PinReservation,
  type PinStaffSnapshot,
  type PinSubject,
  type VerifiedPinSnapshot,
} from './staff-pin-snapshot.ts';

export {
  ANY_MANAGER,
  pinStaffFromResult,
  pinStaffListFromResult,
} from './staff-pin-snapshot.ts';
export type { PinCheck, PinReservation, PinStaffSnapshot, PinSubject, VerifiedPinSnapshot };

const MINUTE = 60_000;
export const PIN_MISSES_PER_PERSON = 5;
export const PIN_PERSON_WINDOW_MS = 5 * MINUTE;
export const PIN_MISSES_PER_SCANNER = 20;
export const PIN_SCANNER_WINDOW_MS = 60 * MINUTE;
const windowOf = (now: number, size: number) => now - (now % size);

/** HMAC-SHA256(K_pin, id:pin), hex. A database leak alone cannot be brute-forced offline. */
export async function hashPin(env: object, staffId: string, pin: string): Promise<string> {
  const key = await derivedHmacKey(env, 'scan-pin');
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${staffId}:${pin}`));
  return toHex(new Uint8Array(mac));
}

export type PinReservationGuard = { sql: string; params: readonly SqlValue[] };
const lockedError = (millisecondsLeft: number) =>
  new RateLimitedError(Math.ceil(millisecondsLeft / 1000), 'Too many wrong PINs. Try again later.');
const resultCount = (result: D1Result | undefined) =>
  (result?.results?.[0] as { count?: number } | undefined)?.count;
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
  const anyone = staffId === ANY_MANAGER;
  // A PIN with no one named tests every manager: the caps shrink by that factor, and an org-wide
  // hourly counter (not per device) bounds the guesses a fleet of paired devices can make.
  const factor = anyone ? Math.max(1, subject.testedManagers ?? 1) : 1;
  const personCap = Math.max(1, Math.floor(PIN_MISSES_PER_PERSON / factor));
  const scannerCap = Math.max(1, Math.floor(PIN_MISSES_PER_SCANNER / factor));
  const personKey = `scan:pin:${scannerId}:${staffId}`;
  const allKey = anyone ? `scan:pinany:${orgId}` : `scan:pinall:${scannerId}`;
  const markerKey = `scan:pin-reservation:${ctx.ids.token()}`;
  const counters = preparePinCounters(db, {
    guard,
    markerKey,
    personKey,
    personWindow,
    personCap,
    allKey,
    allWindow,
    scannerCap,
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
    decide: () => Promise<'match' | 'miss' | 'ambiguous'>,
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
    if (person < 1 || person > personCap || resultCount(results[2]) !== 2)
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
      scanner > scannerCap ||
      !shape(1, 1, 1, 1, 1, 0, 0) ||
      resultCount(results[4]) !== 4
    )
      throw new Error('Incomplete PIN scanner reservation');

    const verdict = await decide();
    if (verdict === 'match') {
      verified = true;
      return true;
    }

    // A miss keeps both reservations, including if the audit subsequently fails.
    settled = true;
    const audits: D1PreparedStatement[] = [];
    if (person === personCap)
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
    if (scanner === scannerCap)
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
    // Two managers with one PIN answer exactly as a wrong one (a different answer would say so);
    // the owner is told in the log, with no PIN in it.
    if (verdict === 'ambiguous')
      ctx.log.warn('scan.pin_ambiguous', { orgId, scannerId, code: 'PIN_AMBIGUOUS' });
    const triesLeft = Math.max(0, personCap - person);
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
      if (
        !(await verifyCandidate(
          results,
          personDecision({ pinEnv, orgId, staffId }, captured, pin, managerOnly, hashPin),
          failure,
        ))
      )
        return null;
      if (!captured) throw new Error('Verified PIN has no staff snapshot');
      return captured;
    },
    async verifyAny(results, managers, pin, failure) {
      if (resultCount(results[0]) === undefined) {
        await verifyCandidate(results, async () => 'miss', failure);
        return null;
      }
      const any = anyManagerDecision({ pinEnv, orgId, staffId }, managers, pin, hashPin);
      return (await verifyCandidate(results, () => any.decide(), failure)) ? any.found() : null;
    },
    async verifyLogin(results, staff, pin) {
      if (
        !(await verifyCandidate(
          results,
          personDecision({ pinEnv, orgId, staffId }, staff, pin, false, hashPin),
        ))
      )
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
