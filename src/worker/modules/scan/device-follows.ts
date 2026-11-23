import type {
  ScanDeviceOverrides,
  ScanSurface,
} from '../../../shared/contracts/scanning-sessions.ts';
import { roleForSurface } from '../../../shared/scan-surfaces.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';

/**
 * The overrides to store. Only a screen follows scanners, so a scan surface drops `follows`. Ids
 * already stored are kept as they are (the live read intersects with the session, so a revoked one
 * is harmless); only newly added ids must be live scan devices of this session.
 */
export function resolveFollows(
  overrides: ScanDeviceOverrides,
  effectiveSurface: ScanSurface,
  siblings: readonly ScanningDeviceRow[],
  stored: readonly string[] = [],
): ScanDeviceOverrides {
  const { follows, ...rest } = overrides;
  if (!follows || roleForSurface(effectiveSurface) === 'scan') return rest;
  const live = new Set(
    siblings
      .filter((d) => d.revoked_at === null && roleForSurface(d.effective_surface) === 'scan')
      .map((d) => d.scanner_id),
  );
  if (!follows.every((id) => stored.includes(id) || live.has(id)))
    throw new ValidationError('Pick scanners from this session.', [], 'SCANNING_FOLLOWS_INVALID');
  return overrides;
}
