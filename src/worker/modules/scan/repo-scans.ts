import type { Mode } from '../../../shared/contracts/common.ts';
import { deleteInBatches } from '../../platform/batched.ts';
import { all, first, stmt } from '../../platform/db.ts';
import type { EventRow } from '../events/repo.ts';
import { type GateKey, wonGate } from './repo-gates.ts';

type Db = D1Database;

export interface ScanRow {
  id: string;
  orgId: string;
  mode: Mode;
  passId: string | null;
  templateId: string | null;
  scannerId: string | null;
  eventId: string | null;
  actorKey: string;
  staffId: string | null;
  requestHash: string;
  state: 'pending' | 'done' | 'failed';
  outcome: 'ok' | 'heads_up' | 'refused' | null;
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  overrideOf: string | null;
  approvedBy: string | null;
  passVersion: number | null;
  method: string;
  at: number;
  undoneBy: string | null;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  pass_id: string | null;
  template_id: string | null;
  scanner_id: string | null;
  event_id: string | null;
  actor_key: string;
  staff_id: string | null;
  request_hash: string;
  state: ScanRow['state'];
  outcome: ScanRow['outcome'];
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  override_of: string | null;
  approved_by: string | null;
  pass_version: number | null;
  method: string;
  at: number;
  undone_by: string | null;
}

export const toScan = (r: Raw): ScanRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  passId: r.pass_id,
  templateId: r.template_id,
  scannerId: r.scanner_id,
  eventId: r.event_id,
  actorKey: r.actor_key,
  staffId: r.staff_id,
  requestHash: r.request_hash,
  state: r.state,
  outcome: r.outcome,
  reason: r.reason,
  actionId: r.action_id,
  actionKind: r.action_kind,
  overrideOf: r.override_of,
  approvedBy: r.approved_by,
  passVersion: r.pass_version,
  method: r.method,
  at: r.at,
  undoneBy: r.undone_by,
});

const COLUMNS = `id, org_id, mode, pass_id, template_id, scanner_id, event_id, actor_key, staff_id, request_hash,
  state, outcome, reason, action_id, action_kind, override_of, approved_by, pass_version, method, at, undone_by`;

export interface Claim {
  id: string;
  orgId: string;
  mode: Mode;
  scannerId: string | null;
  eventId: string | null;
  actorType: 'scanner' | 'user';
  actorId: string;
  actorKey: string;
  staffId: string | null;
  idempotencyKey: string;
  requestHash: string;
  method: string;
  clientTs: number;
  now: number;
}

/** Claims the key: a row back means this request owns it, none means another request does. */
export async function claimScan(db: Db, c: Claim): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `INSERT INTO scans (id, org_id, mode, scanner_id, event_id, actor_type, actor_id, actor_key, staff_id,
       idempotency_key, request_hash, method, state, client_ts, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (actor_key, idempotency_key) DO NOTHING RETURNING id`,
    [
      c.id,
      c.orgId,
      c.mode,
      c.scannerId,
      c.eventId,
      c.actorType,
      c.actorId,
      c.actorKey,
      c.staffId,
      c.idempotencyKey,
      c.requestHash,
      c.method,
      c.clientTs,
      c.now,
    ],
  );
  return row !== null;
}

export async function scanByKey(db: Db, actorKey: string, key: string): Promise<ScanRow | null> {
  const row = await first<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE actor_key = ? AND idempotency_key = ?`,
    [actorKey, key],
  );
  return row ? toScan(row) : null;
}

export async function scanById(db: Db, orgId: string, id: string): Promise<ScanRow | null> {
  const row = await first<Raw>(db, `SELECT ${COLUMNS} FROM scans WHERE id = ? AND org_id = ?`, [
    id,
    orgId,
  ]);
  return row ? toScan(row) : null;
}

/** A failed row is claimed again by the same key. Only a `failed` row moves. */
export async function reopenScan(db: Db, id: string, now: number): Promise<boolean> {
  const row = await first<{ id: string }>(
    db,
    `UPDATE scans SET state = 'pending', at = ? WHERE id = ? AND state = 'failed' RETURNING id`,
    [now, id],
  );
  return row !== null;
}

/** A `ready` card and a `needs_approval` heads-up leave no row and no idempotency entry. */
export const releaseClaimStmt = (db: Db, id: string) =>
  stmt(db, "DELETE FROM scans WHERE id = ? AND state = 'pending'", [id]);

export interface Finalize {
  id: string;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  passId: string | null;
  templateId: string | null;
  actionId: string | null;
  actionKind: string | null;
  passVersion: number | null;
  overrideOf: string | null;
  approvedBy: string | null;
}

/** Closes a pending row. `won` adds the gate guard of the check-in fast path. */
export function finalizeStmt(db: Db, f: Finalize, won?: GateKey): D1PreparedStatement {
  const guard = won ? wonGate(won, f.id) : null;
  return stmt(
    db,
    `UPDATE scans SET state = 'done', outcome = ?, reason = ?, pass_id = ?, template_id = ?, action_id = ?,
       action_kind = ?, pass_version = ?, override_of = ?, approved_by = ?
     WHERE id = ? AND state = 'pending'${guard ? ` AND ${guard.sql}` : ''}`,
    [
      f.outcome,
      f.reason,
      f.passId,
      f.templateId,
      f.actionId,
      f.actionKind,
      f.passVersion,
      f.overrideOf,
      f.approvedBy,
      f.id,
      ...(guard?.params ?? []),
    ],
  );
}

export const failScanStmt = (db: Db, id: string) =>
  stmt(db, "UPDATE scans SET state = 'failed' WHERE id = ? AND state = 'pending'", [id]);

/** A ledger row, written only while this scan still holds the gate. */
export function ledgerIfWonStmt(
  db: Db,
  row: EventRow,
  won: GateKey,
  scanId: string,
): D1PreparedStatement {
  const guard = wonGate(won, scanId);
  return stmt(
    db,
    `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, device, actor_type, actor_id, data, at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    [
      row.id,
      row.org_id,
      row.pass_id,
      row.mode,
      row.kind,
      row.device,
      row.actor_type,
      row.actor_id,
      row.data,
      row.at,
      ...guard.params,
    ],
  );
}

/** A pass's last scans for the desk card (`scans_pass`), newest first, with the scanner's name. */
export const lastScansStmt = (db: Db, orgId: string, passId: string) =>
  stmt(
    db,
    `SELECT s.id, s.at, s.action_id, s.action_kind, s.outcome, s.actor_key, s.staff_id, s.undone_by,
       sc.name AS scanner_name
     FROM scans s LEFT JOIN scanners sc ON sc.id = s.scanner_id
     WHERE s.pass_id = ? AND s.org_id = ? AND s.state = 'done' AND s.action_kind != 'undo'
     ORDER BY s.at DESC, s.id DESC LIMIT 3`,
    [passId, orgId],
  );

export interface RecentRow {
  id: string;
  at: number;
  outcome: 'ok' | 'heads_up' | 'refused';
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  template_id: string | null;
  title: string | null;
  undone_by: string | null;
}

/** The actor's own latest scans (`scans_actor`). */
export function recentScans(db: Db, actorKey: string, limit: number): Promise<RecentRow[]> {
  return all<RecentRow>(
    db,
    `SELECT s.id, s.at, s.outcome, s.reason, s.action_id, s.action_kind, s.template_id,
       p.display_title AS title, s.undone_by
     FROM scans s LEFT JOIN passes p ON p.id = s.pass_id
     WHERE s.actor_key = ? AND s.state = 'done' ORDER BY s.at DESC, s.id DESC LIMIT ?`,
    [actorKey, limit],
  );
}

export interface SummaryRow {
  template_id: string | null;
  action_id: string | null;
  action_kind: string | null;
  outcome: 'ok' | 'heads_up' | 'refused';
  undone: number;
  n: number;
  amount: number;
  first_at: number;
  last_at: number;
}

export function summaryRows(
  db: Db,
  actorKey: string,
  from: number,
  to: number,
): Promise<SummaryRow[]> {
  return all<SummaryRow>(
    db,
    `SELECT template_id, action_id, action_kind, outcome, undone_by IS NOT NULL AS undone, COUNT(*) AS n,
       COALESCE(SUM(amount), 0) AS amount, MIN(at) AS first_at, MAX(at) AS last_at
     FROM scans WHERE actor_key = ? AND at >= ? AND at <= ? AND state = 'done' AND action_kind IS NOT 'undo'
     GROUP BY template_id, action_id, action_kind, outcome, undone_by IS NOT NULL`,
    [actorKey, from, to],
  );
}

/** An override target: an earlier heads-up the same actor wrote (SA 2.6). */
export async function overrideTarget(
  db: Db,
  orgId: string,
  mode: Mode,
  actorKey: string,
  id: string,
  since: number,
): Promise<{ scan: ScanRow; taken: boolean } | null> {
  const row = await first<Raw & { taken: number }>(
    db,
    `SELECT ${COLUMNS}, EXISTS (SELECT 1 FROM scans o WHERE o.actor_key = ? AND o.at >= ?
         AND o.override_of = ? AND o.outcome = 'ok') AS taken
     FROM scans WHERE id = ? AND org_id = ? AND mode = ? AND actor_key = ? AND state = 'done'
       AND outcome = 'heads_up' AND at >= ?`,
    [actorKey, since, id, id, orgId, mode, actorKey, since],
  );
  return row ? { scan: toScan(row), taken: row.taken === 1 } : null;
}

/** Pending rows past the threshold, oldest first. */
export async function pendingScans(db: Db, olderThan: number, limit: number): Promise<ScanRow[]> {
  const rows = await all<Raw>(
    db,
    `SELECT ${COLUMNS} FROM scans WHERE state = 'pending' AND at < ? ORDER BY at LIMIT ?`,
    [olderThan, limit],
  );
  return rows.map(toScan);
}

/** Deletes finished scans of one mode older than the cutoff (`scans_mode_at`), in batches. */
export const deleteScansBefore = (db: Db, mode: Mode, before: number) =>
  deleteInBatches(db, 'scans', 'mode = ? AND at < ?', [mode, before]);
