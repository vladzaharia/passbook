import { SCANNER_TOKEN, type ScannerAuth, type ScannerStore } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import {
  DEVICE_IDLE_MS,
  DEVICE_MAX_MS,
  getScannerByPrefix,
  type ScannerRow,
  touchScanner,
} from './repo-device.ts';

export const TOUCH_EVERY_MS = 60_000;
export { DEVICE_IDLE_MS };

/** The row `resolve` already read, so the guard does not read it again. */
const resolvedRows = new WeakMap<ScannerAuth, ScannerRow>();
export const resolvedRowOf = (auth: ScannerAuth): ScannerRow | undefined => resolvedRows.get(auth);

/**
 * The guard's expiry. A terminal ends at `expires_at`. A device ends when idle past the window (each request
 * slides it) or at an explicit `expires_at` (retention, revoke); the one it is paired with, a default, does not count.
 */
export function scannerExpired(row: ScannerRow, now: number): boolean {
  if (row.kind === 'terminal') return row.expiresAt !== null && row.expiresAt <= now;
  const expiry = row.expiresAt;
  if (expiry !== null && expiry <= now && expiry !== (row.pairedAt ?? Number.NaN) + DEVICE_MAX_MS)
    return true;
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
      const contact = meta?.contact !== false;
      if (
        row.lastSeenAt === null ||
        row.lastSeenAt <= now - TOUCH_EVERY_MS ||
        (contact && (row.contactAt === null || row.contactAt <= now - TOUCH_EVERY_MS))
      )
        await touchScanner(env.DB, row.id, now, meta?.ipPrefix ?? null, TOUCH_EVERY_MS, contact);
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
