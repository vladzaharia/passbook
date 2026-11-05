import { SCANNER_TOKEN, type ScannerAuth, type ScannerStore } from '../../platform/auth.ts';
import { type Clock, systemClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { UnauthenticatedError } from '../../platform/errors.ts';
import { safeEqual, sha256Hex } from '../../platform/ids.ts';
import { getScannerByPrefix, type ScannerRow, touchScanner } from './repo-device.ts';

const DAY = 86_400_000;
export const TOUCH_EVERY_MS = 60_000;
export const DEVICE_IDLE_MS = 30 * DAY;

function expired(row: ScannerRow, now: number): boolean {
  if (row.expiresAt !== null && row.expiresAt <= now) return true;
  if (row.kind === 'terminal') return false;
  return (row.lastSeenAt ?? row.pairedAt ?? now) + DEVICE_IDLE_MS <= now;
}

/**
 * Resolves a presented scanner token: by prefix, then a constant-time hash compare. No cache, so a
 * revocation bites on the next request.
 */
export function createScannerStore(env: AppEnv, clock: Clock = systemClock): ScannerStore {
  return {
    async resolve(token, transport, meta): Promise<ScannerAuth | null> {
      if (!SCANNER_TOKEN.test(token)) return null;
      const row = await getScannerByPrefix(env.DB, token.slice(4, 12));
      if (!row?.tokenHash || !(await safeEqual(await sha256Hex(token), row.tokenHash))) return null;
      if (row.kind !== (transport === 'cookie' ? 'device' : 'terminal')) return null;
      const now = clock.now();
      if (row.revokedAt !== null)
        throw new UnauthenticatedError('This scanner was removed.', 'SCANNER_REVOKED');
      if (expired(row, now))
        throw new UnauthenticatedError('This scanner needs to be paired again.', 'SCANNER_EXPIRED');
      await touchScanner(env.DB, row.id, now, meta?.ipPrefix ?? null, TOUCH_EVERY_MS);
      return {
        kind: 'scanner',
        scannerId: row.id,
        orgId: row.orgId,
        mode: row.mode,
        transport,
        csrfSecret: transport === 'cookie' ? row.csrfSecret : null,
      };
    },
  };
}
