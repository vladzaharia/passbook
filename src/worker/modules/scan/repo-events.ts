import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, likeEscape, placeholders, stmt } from '../../platform/db.ts';

type Db = D1Database;

export interface ConsoleEventRow {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  matchInput: string | null;
  matchValues: string[] | null;
  opensAt: number;
  closesAt: number;
  timeZone: string;
  capacity: number | null;
  reentry: boolean;
  note: string | null;
  expected: number | null;
  expectedAt: number | null;
  archivedAt: number | null;
  templateIds: string[];
  arrived: number;
  scanners: number;
  updatedAt: number;
}

interface Raw {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  note: string | null;
  expected: number | null;
  expected_at: number | null;
  archived_at: number | null;
  template_ids: string | null;
  arrived: number;
  scanners: number;
  updated_at: number;
}

/** `arrived` rides `scan_gates_count`, `scanners` rides `scanners_event`. */
const SELECT = `SELECT e.id, e.org_id, e.mode, e.name, e.match_input, e.match_values, e.opens_at, e.closes_at,
    e.time_zone, e.capacity, e.reentry, e.note, e.expected, e.expected_at, e.archived_at, e.updated_at,
    (SELECT group_concat(x.template_id) FROM scan_event_templates x
       JOIN templates t ON t.id = x.template_id AND t.status != 'deleted'
       WHERE x.event_id = e.id) AS template_ids,
    (SELECT count(*) FROM scan_gates g
       WHERE g.org_id = e.org_id AND g.mode = e.mode AND g.scope = 'event:' || e.id
         AND g.kind = 'check_in' AND g.state IN ('in', 'out')) AS arrived,
    (SELECT count(*) FROM scanners s WHERE s.event_id = e.id AND s.revoked_at IS NULL) AS scanners
  FROM scan_events e`;

const toRow = (r: Raw): ConsoleEventRow => ({
  id: r.id,
  orgId: r.org_id,
  mode: r.mode,
  name: r.name,
  matchInput: r.match_input,
  matchValues: r.match_values ? (JSON.parse(r.match_values) as string[]) : null,
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  timeZone: r.time_zone,
  capacity: r.capacity,
  reentry: r.reentry === 1,
  note: r.note,
  expected: r.expected,
  expectedAt: r.expected_at,
  archivedAt: r.archived_at,
  templateIds: r.template_ids ? r.template_ids.split(',').sort() : [],
  arrived: r.arrived,
  scanners: r.scanners,
  updatedAt: r.updated_at,
});

export async function getConsoleEvent(db: Db, id: string): Promise<ConsoleEventRow | null> {
  const row = await first<Raw>(db, `${SELECT} WHERE e.id = ?`, [id]);
  return row ? toRow(row) : null;
}

export interface EventFilter {
  mode: Mode;
  orgId?: string | undefined;
  status?: 'upcoming' | 'live' | 'ended' | 'archived' | undefined;
  q?: string | undefined;
  now: number;
  cursor?: string | undefined;
  limit: number;
}

/** Newest opening first. An org list rides `scan_events_org`. */
export async function listConsoleEvents(db: Db, f: EventFilter): Promise<ConsoleEventRow[]> {
  const where = ['e.mode = ?'];
  const params: (string | number)[] = [f.mode];
  if (f.orgId) {
    where.push('e.org_id = ?');
    params.push(f.orgId);
  }
  if (f.status === 'archived') where.push('e.archived_at IS NOT NULL');
  else if (f.status) {
    where.push('e.archived_at IS NULL');
    if (f.status === 'upcoming') where.push('e.opens_at > ?');
    if (f.status === 'live') where.push('e.opens_at <= ? AND e.closes_at >= ?');
    if (f.status === 'ended') where.push('e.closes_at < ?');
    params.push(...(f.status === 'live' ? [f.now, f.now] : [f.now]));
  }
  if (f.q) {
    where.push("e.name LIKE ? ESCAPE '\\'");
    params.push(`${likeEscape(f.q)}%`);
  }
  if (f.cursor) {
    where.push('(e.opens_at, e.id) < (SELECT opens_at, id FROM scan_events WHERE id = ?)');
    params.push(f.cursor);
  }
  const rows = await all<Raw>(
    db,
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.opens_at DESC, e.id DESC LIMIT ?`,
    [...params, f.limit],
  );
  return rows.map(toRow);
}

export interface EventValues {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  matchInput: string | null;
  matchValues: string[] | null;
  opensAt: number;
  closesAt: number;
  timeZone: string;
  capacity: number | null;
  reentry: boolean;
  note: string | null;
}

export const insertEventStmt = (
  db: Db,
  e: EventValues,
  createdBy: string,
  now: number,
): D1PreparedStatement =>
  stmt(
    db,
    `INSERT INTO scan_events (id, org_id, mode, name, match_input, match_values, opens_at, closes_at, time_zone,
       capacity, reentry, note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.id,
      e.orgId,
      e.mode,
      e.name,
      e.matchInput,
      e.matchValues ? JSON.stringify(e.matchValues) : null,
      e.opensAt,
      e.closesAt,
      e.timeZone,
      e.capacity,
      e.reentry ? 1 : 0,
      e.note,
      createdBy,
      now,
      now,
    ],
  );

/** Writes every editable column and drops the cached `expected`, so the next read recounts. */
export const updateEventStmt = (db: Db, e: EventValues, now: number): D1PreparedStatement =>
  stmt(
    db,
    `UPDATE scan_events SET name = ?, match_input = ?, match_values = ?, opens_at = ?, closes_at = ?,
       time_zone = ?, capacity = ?, reentry = ?, note = ?, expected = NULL, expected_at = NULL, updated_at = ?
     WHERE id = ?`,
    [
      e.name,
      e.matchInput,
      e.matchValues ? JSON.stringify(e.matchValues) : null,
      e.opensAt,
      e.closesAt,
      e.timeZone,
      e.capacity,
      e.reentry ? 1 : 0,
      e.note,
      now,
      e.id,
    ],
  );

export const replaceEventTemplatesStmts = (
  db: Db,
  eventId: string,
  templateIds: readonly string[],
): D1PreparedStatement[] => [
  stmt(db, 'DELETE FROM scan_event_templates WHERE event_id = ?', [eventId]),
  ...templateIds.map((id) =>
    stmt(db, 'INSERT INTO scan_event_templates (event_id, template_id) VALUES (?, ?)', [
      eventId,
      id,
    ]),
  ),
];

/** Archiving ends the event for every scanner on it: they read as `unassigned` and refetch. */
export const archiveEventStmts = (db: Db, id: string, now: number): D1PreparedStatement[] => [
  stmt(
    db,
    'UPDATE scan_events SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL',
    [now, now, id],
  ),
  stmt(
    db,
    `UPDATE scanning_sessions SET accepts=NULL,settings=json_set(settings,'$.acceptAllTemplates',json('false')),updated_at=MAX(updated_at+1,?) WHERE json_extract(accepts,'$.eventId')=?`,
    [now, id],
  ),
  stmt(db, 'UPDATE scanners SET event_id = NULL, updated_at = ? WHERE event_id = ?', [now, id]),
];

export const restoreEventStmt = (db: Db, id: string, now: number): D1PreparedStatement =>
  stmt(db, 'UPDATE scan_events SET archived_at = NULL, updated_at = ? WHERE id = ?', [now, id]);

export interface AssignableScanner {
  id: string;
  mode: Mode;
  kind: string;
  deviceRole: string;
}

export async function scannersInOrg(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<AssignableScanner[]> {
  if (ids.length === 0) return [];
  const rows = await all<{ id: string; mode: Mode; kind: string; device_role: string }>(
    db,
    `SELECT id, mode, kind, device_role FROM scanners
     WHERE org_id = ? AND id IN (${placeholders(ids.length)})`,
    [orgId, ...ids],
  );
  return rows.map((r) => ({ id: r.id, mode: r.mode, kind: r.kind, deviceRole: r.device_role }));
}

/** Moves scanners onto the event; their own template list no longer applies. */
export const assignScannersStmts = (
  db: Db,
  eventId: string,
  orgId: string,
  ids: readonly string[],
  now: number,
): D1PreparedStatement[] => [
  stmt(
    db,
    `UPDATE scanners SET event_id = ?, updated_at = ? WHERE org_id = ? AND id IN (${placeholders(ids.length)})`,
    [eventId, now, orgId, ...ids],
  ),
  stmt(db, `DELETE FROM scanner_templates WHERE scanner_id IN (${placeholders(ids.length)})`, [
    ...ids,
  ]),
];

/** Live templates of the org, with the active manifest, in the given id order. */
export async function templateManifests(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<{ id: string; manifest: string }[]> {
  if (ids.length === 0) return [];
  return all<{ id: string; manifest: string }>(
    db,
    `SELECT t.id, v.manifest FROM templates t
     JOIN template_versions v ON v.template_id = t.id AND v.version = t.active_version
     WHERE t.org_id = ? AND t.status != 'deleted' AND t.id IN (${placeholders(ids.length)})`,
    [orgId, ...ids],
  );
}

/** Active, not deleted passes of the event's templates that the match rule admits. */
export async function countExpected(
  db: Db,
  e: Pick<ConsoleEventRow, 'orgId' | 'mode' | 'templateIds' | 'matchInput' | 'matchValues'>,
): Promise<number> {
  if (e.templateIds.length === 0) return 0;
  const match = e.matchInput && e.matchValues?.length;
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM passes
     WHERE org_id = ? AND mode = ? AND deleted_at IS NULL AND status = 'active'
       AND template_id IN (${placeholders(e.templateIds.length)})
       ${match ? `AND CAST(json_extract(personalization, ?) AS TEXT) IN (${placeholders(e.matchValues?.length ?? 0)})` : ''}`,
    [
      e.orgId,
      e.mode,
      ...e.templateIds,
      ...(match ? [`$."${e.matchInput}"`, ...(e.matchValues ?? [])] : []),
    ],
  );
  return row?.n ?? 0;
}

export const setExpectedStmt = (db: Db, id: string, n: number, now: number): D1PreparedStatement =>
  stmt(db, 'UPDATE scan_events SET expected = ?, expected_at = ? WHERE id = ?', [n, now, id]);
