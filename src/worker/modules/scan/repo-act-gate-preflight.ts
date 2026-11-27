import { stmt } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import { verifiedPresenceCtesSql } from './repo-event-attendance.ts';
import type { GateKey } from './repo-gates.ts';
import { retainedEventCountSql } from './repo-scan-retention.ts';

/** Read the current holder and the display metadata shown for a held gate. */
export function heldGateHolderStmt(db: D1Database, gate: GateKey): D1PreparedStatement {
  return stmt(
    db,
    `SELECT g.last_at, g.last_scan_id AS gate_scan_id,
      s.id AS scan_id, s.at, s.state AS scan_state, s.action_id, s.scanner_id, s.staff_id,
      s.override_of, sc.name AS scanner_name, st.name AS staff_name
    FROM scan_gates g LEFT JOIN scans s ON s.id=g.last_scan_id
    LEFT JOIN scanners sc ON sc.id=s.scanner_id LEFT JOIN scan_staff st ON st.id=s.staff_id
    WHERE g.pass_id=? AND g.action_id=?
      AND g.scope=?`,
    [gate.passId, gate.actionId, gate.scope],
  );
}

/** Capture capacity with the same live and retained evidence used by event attendance. */
export function heldGateCapacityStmt(
  db: D1Database,
  actor: ScanActor,
  gate: GateKey,
  eventId: string,
): D1PreparedStatement {
  return stmt(
    db,
    `WITH scope AS MATERIALIZED (
      SELECT org_id,mode,id AS event_id,capacity,reentry,? AS pass_id
      FROM scan_events WHERE id=? AND org_id=? AND mode=?
    ), ${verifiedPresenceCtesSql('scope', true)}, totals AS MATERIALIZED (
      SELECT COUNT(DISTINCT verified.pass_id) AS arrived,
        COUNT(DISTINCT CASE WHEN verified.state='in' THEN verified.pass_id END) AS inside,
        COALESCE(MAX(CASE WHEN verified.pass_id=scope.pass_id THEN 1 ELSE 0 END),0) AS has_arrived,
        COALESCE(MAX(CASE WHEN verified.pass_id=scope.pass_id AND verified.state='in'
          THEN 1 ELSE 0 END),0) AS has_inside
      FROM verified CROSS JOIN scope
    )
    SELECT CASE WHEN scope.capacity IS NULL THEN 0 WHEN scope.reentry=1 THEN
      (totals.inside + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', true)}
        >=scope.capacity AND NOT totals.has_inside)
      ELSE (totals.arrived + ${retainedEventCountSql('scope.org_id', 'scope.mode', 'scope.event_id', false)}
        >=scope.capacity AND NOT totals.has_arrived) END AS full
    FROM scope CROSS JOIN totals`,
    [gate.passId, eventId, actor.orgId, actor.mode],
  );
}
