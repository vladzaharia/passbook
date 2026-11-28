import type { ScanDeviceOverrides } from '../../../shared/contracts/scanning-sessions.ts';
import { roleOfStoredSurface, type StoredEffectiveSurface } from '../../../shared/scan-surfaces.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';

/**
 * The overrides to store. Only newly added ids must be live scan devices of this session: stored
 * ids are harmless because the live read intersects with the session. On a scan surface `follows`
 * is inert, so a save that omits it keeps the stored ids; the device may flip back to a screen
 * without a PIN, and dropping them would widen it to every scanner.
 */
export function resolveFollows(
  overrides: ScanDeviceOverrides,
  effectiveSurface: StoredEffectiveSurface,
  siblings: readonly ScanningDeviceRow[],
  stored: readonly string[] = [],
): ScanDeviceOverrides {
  const { follows, ...rest } = overrides;
  if (!follows)
    return roleOfStoredSurface(effectiveSurface) === 'scan' && stored.length
      ? { ...rest, follows: [...stored] }
      : rest;
  const live = new Set(
    siblings
      .filter((d) => d.revoked_at === null && roleOfStoredSurface(d.effective_surface) === 'scan')
      .map((d) => d.scanner_id),
  );
  if (!follows.every((id) => stored.includes(id) || live.has(id)))
    throw new ValidationError('Pick scanners from this session.', [], 'SCANNING_FOLLOWS_INVALID');
  return overrides;
}
