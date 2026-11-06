import { first, stmt } from '../../platform/db.ts';
import type { AdmissionHistory, AdmissionPlan, PresenceRow } from './admission-types.ts';
import { type GateKey, wonGate } from './repo-gates.ts';

const historyStmt = (
  db: D1Database,
  orgId: string,
  passId: string,
  eventId: string | null,
  since: number,
) =>
  stmt(
    db,
    `WITH entries AS (SELECT at FROM scans
    WHERE org_id=? AND pass_id=? AND (? IS NULL OR event_id=?) AND outcome='ok'
    AND action_kind='check_in' AND (direction IS NULL OR direction='in') AND undone_by IS NULL
    UNION ALL SELECT last_at FROM scan_gates WHERE org_id=? AND pass_id=?
    AND (? IS NULL OR scope=?) AND kind='check_in' AND state IN ('in','out'))
    SELECT MIN(at) AS first_at,MAX(at) AS last_at,MAX(CASE WHEN at>=? THEN at END) AS today_at FROM entries`,
    [
      orgId,
      passId,
      eventId,
      eventId,
      orgId,
      passId,
      eventId,
      eventId ? `event:${eventId}` : null,
      since,
    ],
  );

export const presenceOf = (db: D1Database, orgId: string, passId: string, scope: string) =>
  first<PresenceRow>(
    db,
    'SELECT state,tracking,entered_at,first_at,last_entry_at,last_scan_id FROM scan_presence WHERE org_id=? AND pass_id=? AND scope=?',
    [orgId, passId, scope],
  );

export async function admissionReads(
  db: D1Database,
  orgId: string,
  passId: string,
  eventId: string | null,
  since: number,
  scope: string,
) {
  const results = await db.batch([
    historyStmt(db, orgId, passId, eventId, since),
    stmt(
      db,
      'SELECT state,tracking,entered_at,first_at,last_entry_at,last_scan_id FROM scan_presence WHERE org_id=? AND pass_id=? AND scope=?',
      [orgId, passId, scope],
    ),
  ]);
  return {
    history: (results[0]?.results[0] ?? null) as AdmissionHistory | null,
    presence: (results[1]?.results[0] ?? null) as PresenceRow | null,
  };
}

export function recordPresenceStmt(
  db: D1Database,
  orgId: string,
  gate: GateKey,
  scanId: string,
  now: number,
  p: AdmissionPlan,
) {
  const won = wonGate(gate, scanId);
  return stmt(
    db,
    `INSERT INTO scan_presence(pass_id,org_id,scope,state,tracking,entered_at,first_at,last_entry_at,last_scan_id)
    SELECT ?,?,?,?,?,?,?,?,? WHERE ${won.sql}
    ON CONFLICT(pass_id,scope) DO UPDATE SET prev_state=state,prev_tracking=tracking,prev_entered_at=entered_at,
      prev_first_at=first_at,prev_last_entry_at=last_entry_at,prev_scan_id=last_scan_id,state=excluded.state,
      last_entry_at=CASE WHEN excluded.state='in' THEN excluded.last_entry_at ELSE last_entry_at END,
      tracking=excluded.tracking,entered_at=excluded.entered_at,last_scan_id=excluded.last_scan_id`,
    [
      gate.passId,
      orgId,
      p.scope,
      p.state.direction,
      p.tracked,
      p.state.direction === 'in' ? now : null,
      p.state.firstAt ?? now,
      now,
      scanId,
      ...won.params,
    ],
  );
}

export function restorePresenceStmts(
  db: D1Database,
  passId: string,
  targetId: string,
  undoId: string,
) {
  return [
    stmt(
      db,
      `UPDATE scan_presence SET state=prev_state,tracking=prev_tracking,entered_at=prev_entered_at,
    first_at=prev_first_at,last_entry_at=prev_last_entry_at,last_scan_id=prev_scan_id,prev_state=NULL,prev_entered_at=NULL,
    prev_first_at=NULL,prev_tracking=NULL,prev_last_entry_at=NULL,prev_scan_id=NULL WHERE pass_id=? AND last_scan_id=? AND prev_state IS NOT NULL
    AND EXISTS (SELECT 1 FROM scans WHERE id=? AND undone_by=?)`,
      [passId, targetId, targetId, undoId],
    ),
    stmt(
      db,
      `DELETE FROM scan_presence WHERE pass_id=? AND last_scan_id=? AND prev_state IS NULL
    AND EXISTS (SELECT 1 FROM scans WHERE id=? AND undone_by=?)`,
      [passId, targetId, targetId, undoId],
    ),
  ];
}
