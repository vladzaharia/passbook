import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, placeholders, type SqlValue } from '../../platform/db.ts';

type Db = D1Database;

/** One `scans` row with the names the console shows. Holds no holder data beyond the pass title. */
export interface ScanLogRow {
  id: string;
  orgId: string;
  mode: Mode;
  at: number;
  outcome: 'ok' | 'heads_up' | 'refused' | null;
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  direction: 'in' | 'out' | null;
  passId: string | null;
  passTitle: string | null;
  externalId: string | null;
  templateId: string | null;
  templateName: string | null;
  eventId: string | null;
  eventName: string | null;
  scannerId: string | null;
  scannerName: string | null;
  staffId: string | null;
  staffName: string | null;
  approvedBy: string | null;
  method: 'camera' | 'wedge' | 'nfc' | 'manual' | 'auto';
  amount: number | null;
  before: string | null;
  after: string | null;
  passVersion: number | null;
  override: boolean;
  offline: boolean;
  actorType: 'scanner' | 'user' | 'system';
  actorId: string;
  undoneAt: number | null;
  undoneBy: string | null;
  undoes: string | null;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  at: number;
  outcome: ScanLogRow['outcome'];
  reason: string | null;
  action_id: string | null;
  action_kind: string | null;
  direction: 'in' | 'out' | null;
  pass_id: string | null;
  pass_title: string | null;
  external_id: string | null;
  template_id: string | null;
  template_name: string | null;
  event_id: string | null;
  event_name: string | null;
  scanner_id: string | null;
  scanner_name: string | null;
  staff_id: string | null;
  staff_name: string | null;
  approver_name: string | null;
  method: ScanLogRow['method'];
  amount: number | null;
  before_value: string | null;
  after_value: string | null;
  pass_version: number | null;
  override_of: string | null;
  offline: number;
  actor_type: ScanLogRow['actorType'];
  actor_id: string;
  undone_at: number | null;
  undone_by_name: string | null;
  undone_by: string | null;
  undoes: string | null;
}

/** Every join is on a primary key, so a page of 100 stays 100 index probes per table. */
const SELECT = `SELECT s.id, s.org_id, s.mode, s.at, s.outcome, s.reason, s.action_id, s.action_kind, s.direction,
    s.pass_id, p.display_title AS pass_title, p.external_id, s.template_id, t.name AS template_name,
    s.event_id, e.name AS event_name, s.scanner_id, sc.name AS scanner_name, s.staff_id, st.name AS staff_name,
    ap.name AS approver_name, s.method, s.amount, s.before_value, s.after_value, s.pass_version, s.override_of,
    s.offline, s.actor_type, s.actor_id, s.undone_at, s.undone_by, s.undoes,
    coalesce(ust.name, usc.name, CASE WHEN u.actor_type = 'user' THEN 'Admin console' END) AS undone_by_name
  FROM scans s
  LEFT JOIN passes p ON p.id = s.pass_id
  LEFT JOIN templates t ON t.id = s.template_id
  LEFT JOIN scan_events e ON e.id = s.event_id
  LEFT JOIN scanners sc ON sc.id = s.scanner_id
  LEFT JOIN scan_staff st ON st.id = s.staff_id
  LEFT JOIN scan_staff ap ON ap.id = s.approved_by
  LEFT JOIN scans u ON u.id = s.undone_by
  LEFT JOIN scan_staff ust ON ust.id = u.staff_id
  LEFT JOIN scanners usc ON usc.id = u.scanner_id`;

const toRow = (r: Raw): ScanLogRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  at: r.at,
  outcome: r.outcome,
  reason: r.reason,
  actionId: r.action_id,
  actionKind: r.action_kind,
  direction: r.direction,
  passId: r.pass_id,
  passTitle: r.pass_title,
  externalId: r.external_id,
  templateId: r.template_id,
  templateName: r.template_name,
  eventId: r.event_id,
  eventName: r.event_name,
  scannerId: r.scanner_id,
  scannerName: r.scanner_name,
  staffId: r.staff_id,
  staffName: r.staff_name,
  approvedBy: r.approver_name,
  method: r.method,
  amount: r.amount,
  before: r.before_value,
  after: r.after_value,
  passVersion: r.pass_version,
  override: r.override_of !== null,
  offline: r.offline === 1,
  actorType: r.actor_type,
  actorId: r.actor_id,
  undoneAt: r.undone_at,
  undoneBy: r.undone_by_name ?? (r.undone_by ? 'Unknown' : null),
  undoes: r.undoes,
});

export interface ScanLogFilter {
  mode: Mode;
  orgId?: string | undefined;
  scannerId?: string | undefined;
  staffId?: string | undefined;
  eventId?: string | undefined;
  passId?: string | undefined;
  outcome?: string | undefined;
  reason?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  /** The last scan id of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

function where(f: ScanLogFilter): { sql: string; params: SqlValue[] } {
  // With a scanner, staff, event or pass filter and no org, the `+` keeps the planner on that
  // column's index: `scans_mode_at` would read every scan of the mode and sort them.
  const narrow = !f.orgId && (f.scannerId || f.staffId || f.eventId || f.passId);
  const clauses = [narrow ? '+s.mode = ?' : 's.mode = ?'];
  const params: SqlValue[] = [f.mode];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  eq('s.org_id', f.orgId);
  eq('s.scanner_id', f.scannerId);
  eq('s.staff_id', f.staffId);
  eq('s.event_id', f.eventId);
  eq('s.pass_id', f.passId);
  eq('s.outcome', f.outcome);
  eq('s.reason', f.reason);
  if (f.from !== undefined) {
    clauses.push('s.at >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    clauses.push('s.at <= ?');
    params.push(f.to);
  }
  if (f.cursor) {
    clauses.push('(s.at, s.id) < (SELECT at, id FROM scans WHERE id = ?)');
    params.push(f.cursor);
  }
  return { sql: clauses.join(' AND '), params };
}

/** Newest first. An org list rides `scans_org`; a scanner, staff, event or pass filter rides its own index. */
export async function listScanRows(db: Db, f: ScanLogFilter): Promise<ScanLogRow[]> {
  const { sql, params } = where(f);
  const rows = await all<Raw>(db, `${SELECT} WHERE ${sql} ORDER BY s.at DESC, s.id DESC LIMIT ?`, [
    ...params,
    f.limit,
  ]);
  return rows.map(toRow);
}

export async function getScanRow(db: Db, id: string): Promise<ScanLogRow | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE s.id = ?`, [id]);
  return row ? toRow(row) : null;
}

/** Rows the filter matches, counted up to `cap + 1`. */
export async function countScanRows(db: Db, f: ScanLogFilter, cap: number): Promise<number> {
  const { sql, params } = where(f);
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM (SELECT 1 FROM scans s WHERE ${sql} LIMIT ?)`,
    [...params, cap + 1],
  );
  return row?.n ?? 0;
}

/** Active manifests by template id, to turn an action id into the label the scan was made under. */
export async function manifestsOf(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await all<{ id: string; manifest: string }>(
    db,
    `SELECT t.id, v.manifest FROM templates t
     JOIN template_versions v ON v.template_id = t.id AND v.version = t.active_version
     WHERE t.id IN (${placeholders(ids.length)})`,
    [...ids],
  );
  for (const r of rows) out.set(r.id, r.manifest);
  return out;
}
