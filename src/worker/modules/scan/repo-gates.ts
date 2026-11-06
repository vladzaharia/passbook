import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { admissionPredicate } from './repo-admission-limits.ts';

type Db = D1Database;

/** One gate row: a pass, an action and a scope (`''`, `event:<id>` or `day:<date>`). */
export interface GateKey {
  passId: string;
  actionId: string;
  scope: string;
}

/** Which first-scan-wins rule lets the UPSERT through (SA 7.3). */
export type GateRule =
  | { rule: 'once' }
  | { rule: 'cooldown'; cooldownMs: number }
  | { rule: 'always' };

export interface GateClaim extends GateKey {
  orgId: string;
  mode: Mode;
  templateId: string;
  kind: string;
  state: 'in' | 'out' | 'used';
  scanId: string;
  now: number;
  gate: GateRule;
  capacity?: { eventId: string; max: number; reentry: boolean };
  admission?: AdmissionPlan;
}

/**
 * The atomic first-scan-wins. A row comes back (`last_scan_id`) only when this scan took the gate;
 * the previous state is kept so a failed effect can put it back.
 */
export function upsertGateStmt(db: Db, g: GateClaim): D1PreparedStatement {
  const allowed =
    g.gate.rule === 'once'
      ? "scan_gates.state = 'undone'"
      : g.gate.rule === 'cooldown'
        ? 'scan_gates.last_at <= ?'
        : '1';
  const capacity = g.capacity;
  const admission = admissionPredicate(g.orgId, g.passId, g.admission);
  const room = capacity
    ? `((SELECT count(DISTINCT g.pass_id) FROM scan_gates g
        LEFT JOIN scan_presence p ON p.org_id=g.org_id AND p.pass_id=g.pass_id AND p.scope=g.scope
        WHERE g.org_id=? AND g.mode=? AND g.scope=? AND g.kind='check_in'
        AND ${capacity.reentry ? "COALESCE(p.state,g.state)='in'" : "g.state IN ('in','out')"}) < ?
      OR EXISTS (SELECT 1 FROM scan_gates g
        LEFT JOIN scan_presence p ON p.org_id=g.org_id AND p.pass_id=g.pass_id AND p.scope=g.scope
        WHERE g.pass_id=? AND g.scope=? AND ${capacity.reentry ? "COALESCE(p.state,g.state)='in'" : "g.state IN ('in','out')"}))`
    : '1';
  return stmt(
    db,
    `INSERT INTO scan_gates (pass_id, action_id, scope, org_id, mode, template_id, kind, state, count, first_at, last_at, last_scan_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${room} AND ${admission.sql}
     ON CONFLICT (pass_id, action_id, scope) DO UPDATE SET
       prev_state = state, prev_last_at = last_at, prev_scan_id = last_scan_id,
       state = excluded.state, count = count + 1, last_at = excluded.last_at, last_scan_id = excluded.last_scan_id
     WHERE ${allowed}
     RETURNING last_scan_id`,
    [
      g.passId,
      g.actionId,
      g.scope,
      g.orgId,
      g.mode,
      g.templateId,
      g.kind,
      g.state,
      g.now,
      g.now,
      g.scanId,
      ...(capacity
        ? [g.orgId, g.mode, `event:${capacity.eventId}`, capacity.max, g.passId, g.scope]
        : []),
      ...admission.params,
      ...(g.gate.rule === 'cooldown' ? [g.now - g.gate.cooldownMs] : []),
    ],
  );
}

/** The scan that holds the gate now, with who and where, for `previous` and `cooldown`. */
export const gateHolderStmt = (db: Db, g: GateKey): D1PreparedStatement =>
  stmt(
    db,
    `SELECT g.state AS gate_state, g.last_at, s.id AS scan_id, s.at, s.state AS scan_state, s.action_id,
       s.override_of, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_gates g
     LEFT JOIN scans s ON s.id = g.last_scan_id
     LEFT JOIN scanners sc ON sc.id = s.scanner_id
     LEFT JOIN scan_staff st ON st.id = s.staff_id
     WHERE g.pass_id = ? AND g.action_id = ? AND g.scope = ?`,
    [g.passId, g.actionId, g.scope],
  );

/** SQL and params for "this scan holds the gate": the guard on every statement that follows a claim. */
export const wonGate = (g: GateKey, scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scan_gates WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ?)`,
  params: [g.passId, g.actionId, g.scope, scanId],
});

/**
 * Puts a gate back after a scan that never committed: the previous state when this scan was an
 * update, no row at all when it inserted the gate. Both guard on `last_scan_id`.
 */
export function releaseGateStmts(db: Db, g: GateKey, scanId: string): D1PreparedStatement[] {
  const at = [g.passId, g.actionId, g.scope, scanId];
  return [
    stmt(
      db,
      `UPDATE scan_gates SET state = prev_state, last_at = prev_last_at, last_scan_id = prev_scan_id,
         count = count - 1, prev_state = NULL, prev_last_at = NULL, prev_scan_id = NULL
       WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ? AND prev_state IS NOT NULL`,
      at,
    ),
    stmt(
      db,
      `DELETE FROM scan_gates
       WHERE pass_id = ? AND action_id = ? AND scope = ? AND last_scan_id = ? AND prev_state IS NULL`,
      at,
    ),
  ];
}

/** Every gate row of a pass (PK prefix): the card reads the door state and cooldowns from these. */
export const gatesOfPassStmt = (db: Db, passId: string): D1PreparedStatement =>
  stmt(db, 'SELECT action_id, scope, state, last_at FROM scan_gates WHERE pass_id = ?', [passId]);

/** The gate a scan holds, if it still does: lets reconcile tell a won scan from a lost one. */
export const gateOfScanStmt = (
  db: Db,
  passId: string,
  actionId: string,
  scanId: string,
): D1PreparedStatement =>
  stmt(
    db,
    'SELECT scope FROM scan_gates WHERE pass_id = ? AND action_id = ? AND last_scan_id = ?',
    [passId, actionId, scanId],
  );

export const passVersionStmt = (db: Db, passId: string): D1PreparedStatement =>
  stmt(db, 'SELECT version FROM passes WHERE id = ?', [passId]);
