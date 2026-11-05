import { bump } from '../../platform/counters.ts';
import { derivedHmacKey } from '../../platform/crypto.ts';
import { AppError, RateLimitedError } from '../../platform/errors.ts';
import { safeEqual, toHex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { auditStmt } from '../audit/repo.ts';
import type { ScanStaffRow } from './repo-staff.ts';

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

export interface PinCheck {
  /** `scanners.id` the PIN was typed on. */
  scannerId: string;
  orgId: string;
  /** The id the caller named; counted even when no such staff member exists in the org. */
  staffId: string;
  /** The org's row for that id, or null. */
  staff: Pick<ScanStaffRow, 'orgId' | 'pinHash' | 'disabledAt'> | null;
  pin: string;
}

const personKey = (c: PinCheck) => `scan:pin:${c.scannerId}:${c.staffId}`;
const allKey = (scannerId: string) => `scan:pinall:${scannerId}`;

const lockedError = (secondsLeft: number) =>
  new RateLimitedError(Math.ceil(secondsLeft / 1000), 'Too many wrong PINs. Try again later.');

/**
 * Verifies a staff PIN on a scanner. Throws 400 PIN_INVALID (with the tries left) on a miss and
 * 429 once that person is locked on that scanner, or the scanner is locked for every name. A PIN
 * of another org's staff, or a disabled one, is a plain miss. Never logs the PIN.
 *
 * The attempt is reserved before the PIN is compared: both counters are bumped first, and only
 * the callers whose bump landed inside a cap get a guess, so a burst of concurrent requests
 * cannot test more PINs than the caps allow. A match gives the reservation back.
 */
export async function checkPin(ctx: ServiceContext, check: PinCheck): Promise<void> {
  const now = ctx.clock.now();
  const personWindow = windowOf(now, PIN_PERSON_WINDOW_MS);
  const allWindow = windowOf(now, PIN_SCANNER_WINDOW_MS);
  const person = await bump(ctx.env.DB, personKey(check), personWindow);
  if (person > PIN_MISSES_PER_PERSON) throw lockedError(personWindow + PIN_PERSON_WINDOW_MS - now);
  const all = await bump(ctx.env.DB, allKey(check.scannerId), allWindow);
  if (all > PIN_MISSES_PER_SCANNER) {
    await bump(ctx.env.DB, personKey(check), personWindow, -1);
    throw lockedError(allWindow + PIN_SCANNER_WINDOW_MS - now);
  }

  const usable = check.staff?.orgId === check.orgId && check.staff.disabledAt === null;
  const expected = await hashPin(ctx.env, check.staffId, check.pin);
  if (usable && (await safeEqual(expected, check.staff?.pinHash ?? ''))) {
    await Promise.all([
      bump(ctx.env.DB, personKey(check), personWindow, -1),
      bump(ctx.env.DB, allKey(check.scannerId), allWindow, -1),
    ]);
    return;
  }

  const audits: Promise<unknown>[] = [];
  if (person === PIN_MISSES_PER_PERSON)
    audits.push(
      auditStmt(ctx.env.DB, ctx, {
        orgId: check.orgId,
        actorType: 'scanner',
        actorId: check.scannerId,
        action: 'scan_staff.pin_locked',
        targetType: 'scan_staff',
        targetId: check.staffId,
      }).run(),
    );
  if (all === PIN_MISSES_PER_SCANNER)
    audits.push(
      auditStmt(ctx.env.DB, ctx, {
        orgId: check.orgId,
        actorType: 'scanner',
        actorId: check.scannerId,
        action: 'scanner.pin_flood',
        targetType: 'scanner',
        targetId: check.scannerId,
      }).run(),
    );
  await Promise.all(audits);
  const triesLeft = Math.max(0, PIN_MISSES_PER_PERSON - person);
  throw new AppError(
    'PIN_INVALID',
    400,
    triesLeft > 0 ? `Wrong PIN. ${triesLeft} tries left.` : 'Wrong PIN. Try again later.',
    { issues: [{ path: 'triesLeft', message: String(triesLeft) }] },
  );
}
