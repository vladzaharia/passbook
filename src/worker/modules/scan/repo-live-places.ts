import type { Mode } from '../../../shared/contracts/common.ts';
import { eventTotalsStmt } from './repo-event-attendance.ts';
import { type ScanReadAuthority, scanRead } from './repo-read-authority.ts';

/** An event's name and capacity under the monitor's own authority; no row when it fails or the event is gone. */
export function livePlaceEventStmt(
  db: D1Database,
  auth: ScanReadAuthority,
  orgId: string,
  mode: Mode,
  eventId: string,
): D1PreparedStatement {
  return scanRead(
    db,
    auth,
    `SELECT e.name, e.capacity, e.reentry FROM ${auth.rows}scan_events e
      WHERE ${auth.present} AND ${auth.tenantOnce('e', 'scan_events')}
        AND e.id=? AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL`,
    [eventId, orgId, mode],
  );
}

export { eventTotalsStmt as livePlaceTotalsStmt };
