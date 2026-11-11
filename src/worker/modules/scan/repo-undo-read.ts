import { exactStmt } from '../../platform/db.ts';
import { type Raw, type ScanRow, toScan } from './repo-scan-map.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { type ScanStaffRow, type StaffRaw, staffStatement, toStaff } from './repo-staff.ts';
import type { UndoGate, UndoPresence } from './repo-undo.ts';

const COLUMNS = `id, org_id, mode, pass_id, template_id, scanner_id, event_id, actor_key, staff_id, request_hash,
  state, outcome, reason, action_id, action_kind, override_of, approved_by, pass_version, method, at, undone_by, direction, presence_scope`;

export interface UndoRead {
  /** The undo already committed under this key. */
  existing: ScanRow | null;
  target: ScanRow | null;
  /** The gate and presence the target last wrote; null when a later scan replaced them. */
  gate: UndoGate | null;
  presence: UndoPresence | null;
  /** The target's event, for the actor that is not bound to it. */
  event: ScanEventRow | null;
  /** The manager row named by the request's approval, as it stood before the PIN was verified. */
  approver: ScanStaffRow | null;
}

interface EventRaw {
  id: string;
  org_id: string;
  mode: ScanEventRow['mode'];
  name: string;
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  note: string | null;
  updated_at: number;
  archived_at: number | null;
}

const toEvent = (r: EventRaw): ScanEventRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  matchInput: r.match_input,
  matchValues: r.match_values,
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  timeZone: r.time_zone,
  capacity: r.capacity,
  reentry: r.reentry === 1,
  note: r.note,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
});

/** One round trip: the key, the target and what it last wrote. Gate and presence hang off the target row. */
export async function readUndo(
  db: D1Database,
  orgId: string,
  actorKey: string,
  key: string,
  scanId: string,
  approverId?: string,
): Promise<UndoRead> {
  const [existing, target, gate, presence, event, approver] = await db.batch([
    exactStmt(db, `SELECT ${COLUMNS} FROM scans WHERE actor_key = ? AND idempotency_key = ?`, [
      actorKey,
      key,
    ]),
    exactStmt(db, `SELECT ${COLUMNS} FROM scans WHERE id = ? AND org_id = ?`, [scanId, orgId]),
    exactStmt(
      db,
      `SELECT g.scope,g.template_id,g.kind,g.state,g.count,g.first_at,g.last_at,g.prev_state,g.prev_last_at,g.prev_scan_id
       FROM scans q JOIN scan_gates g ON g.org_id = q.org_id AND g.mode = q.mode AND g.pass_id = q.pass_id
         AND g.action_id = q.action_id AND g.last_scan_id = q.id
       WHERE q.id = ? AND q.org_id = ?`,
      [scanId, orgId],
    ),
    exactStmt(
      db,
      `SELECT p.state,p.tracking,p.entered_at,p.first_at,p.last_entry_at,p.prev_state,p.prev_tracking,
         p.prev_entered_at,p.prev_first_at,p.prev_last_entry_at,p.prev_scan_id
       FROM scans q JOIN scan_presence p ON p.org_id = q.org_id AND p.pass_id = q.pass_id
         AND p.scope = q.presence_scope AND p.last_scan_id = q.id
       WHERE q.id = ? AND q.org_id = ?`,
      [scanId, orgId],
    ),
    exactStmt(
      db,
      `SELECT e.id,e.org_id,e.mode,e.name,e.match_input,e.match_values,e.opens_at,e.closes_at,e.time_zone,
         e.capacity,e.reentry,e.note,e.updated_at,e.archived_at
       FROM scans q JOIN scan_events e ON e.id = q.event_id AND e.org_id = q.org_id
       WHERE q.id = ? AND q.org_id = ?`,
      [scanId, orgId],
    ),
    // Without an approval this reads no row (`id` is never NULL).
    staffStatement(db, orgId, approverId ?? ''),
  ]);
  const row = <T>(r: D1Result | undefined) => (r?.results?.[0] ?? null) as T | null;
  const mapped = (r: D1Result | undefined) => {
    const raw = row<Raw>(r);
    return raw ? toScan(raw) : null;
  };
  return {
    existing: mapped(existing),
    target: mapped(target),
    gate: row<UndoGate>(gate),
    presence: row<UndoPresence>(presence),
    event: ((e) => (e ? toEvent(e) : null))(row<EventRaw>(event)),
    approver: approverId ? ((a) => (a ? toStaff(a) : null))(row<StaffRaw>(approver)) : null,
  };
}
