import { SCANNER_TOKEN, type ScannerAuth, type ScannerStore } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { getScannerByPrefix, type ScannerRow, touchScanner } from './repo-device.ts';

const DAY = 86_400_000;
export const TOUCH_EVERY_MS = 60_000;
export const DEVICE_IDLE_MS = 30 * DAY;

/** The row `resolve` already read, so the guard does not read it again. */
const resolvedRows = new WeakMap<ScannerAuth, ScannerRow>();
export const resolvedRowOf = (auth: ScannerAuth): ScannerRow | undefined => resolvedRows.get(auth);

/** The guard's expiry: past `expires_at`, or a device idle past the window (a terminal never idles). */
export function scannerExpired(row: ScannerRow, now: number): boolean {
  if (row.expiresAt !== null && row.expiresAt <= now) return true;
  if (row.kind === 'terminal') return false;
  return (row.lastSeenAt ?? row.pairedAt ?? now) + DEVICE_IDLE_MS <= now;
}

/**
 * Resolves a presented scanner token: by prefix, then a constant-time hash compare. No cache, so a
 * revocation bites on the next request. Revoking keeps the token columns and sets `revoked_at`;
 * that is how a removed device hears SCANNER_REVOKED instead of being unknown.
 */
export function createScannerStore(env: AppEnv, clock: Clock = systemClock): ScannerStore {
  return {
    async resolve(token, transport, meta): Promise<ScannerAuth | null> {
      if (!SCANNER_TOKEN.test(token)) return null;
      const row = await getScannerByPrefix(env.DB, token.slice(4, 12));
      if (!row?.tokenHash || !(await safeEqual(await sha256Hex(token), row.tokenHash))) return null;
      if (transport === 'bearer' ? row.kind !== 'terminal' : row.kind === 'terminal') return null;
      const now = clock.now();
      if (row.revokedAt !== null)
        throw new UnauthenticatedError('This scanner was removed.', 'SCANNER_REVOKED');
      if (scannerExpired(row, now))
        throw new UnauthenticatedError('This scanner needs to be paired again.', 'SCANNER_EXPIRED');
      if (row.lastSeenAt === null || row.lastSeenAt <= now - TOUCH_EVERY_MS)
        await touchScanner(env.DB, row.id, now, meta?.ipPrefix ?? null, TOUCH_EVERY_MS);
      const auth: ScannerAuth = {
        kind: 'scanner',
        scannerId: row.id,
        orgId: row.orgId,
        mode: row.mode,
        transport,
        csrfSecret: transport === 'cookie' ? row.csrfSecret : null,
        scannerKind: row.kind,
        deviceRole: row.deviceRole,
      };
      resolvedRows.set(auth, row);
      return auth;
    },
  };
}
