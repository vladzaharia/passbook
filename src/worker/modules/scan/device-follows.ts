import type {
  ScanDeviceOverrides,
  ScanSurface,
} from '../../../shared/contracts/scanning-sessions.ts';
import { roleForSurface } from '../../../shared/scan-surfaces.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ScanningDeviceRow } from './repo-scanning-devices.ts';

/**
 * A customer screen may follow only live scan-role devices of its own session. A screen with no `follows`
 * watches them all.
 */
export function assertFollows(
  overrides: ScanDeviceOverrides,
  effectiveSurface: ScanSurface,
  siblings: readonly ScanningDeviceRow[],
): void {
  const follows = overrides.follows;
  if (!follows) return;
  if (roleForSurface(effectiveSurface) === 'scan')
    throw new ValidationError(
      'Only a customer screen follows scanners.',
      [],
      'SCANNING_FOLLOWS_INVALID',
    );
  const live = new Set(
    siblings
      .filter((d) => d.revoked_at === null && roleForSurface(d.effective_surface) === 'scan')
      .map((d) => d.scanner_id),
  );
  if (!follows.every((id) => live.has(id)))
    throw new ValidationError('Pick scanners from this session.', [], 'SCANNING_FOLLOWS_INVALID');
}
