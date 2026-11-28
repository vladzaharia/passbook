import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';

/** The mode this device scans in, as staff name it: Door, Desk, Manager or Operator. */
export function modeLabel(session: ScanSession): string {
  const m = SCAN_COPY.mode;
  const device = session.workspace?.device;
  if (device?.effectiveSurface === 'operator') return m.operator;
  if (device?.deviceRole === 'monitor') return m.desk;
  return session.staff?.role === 'manager'
    ? m.manager
    : session.staff?.role === 'desk'
      ? m.desk
      : m.door;
}
