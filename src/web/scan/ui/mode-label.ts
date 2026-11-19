import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';

/** The mode this device scans in, as staff name it: Door, Desk, Manager or Operator. */
export function modeLabel(session: ScanSession): string {
  const m = SCAN_COPY.mode;
  const surface = session.workspace?.device.effectiveSurface;
  if (surface === 'operator') return m.operator;
  if (surface === 'desk') return m.desk;
  return session.staff?.role === 'manager'
    ? m.manager
    : session.staff?.role === 'desk'
      ? m.desk
      : m.door;
}
