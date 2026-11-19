// Occupancy reads: a lost entry's rows, In now with revisions, an undo's rows and who's inside.
import { type AfterRead, afterRead } from '../../../platform/authority-after.ts';
import { all, type SqlValue, stmt } from '../../../platform/db.ts';
import type { PresenceRow } from '../admission-types.ts';
import { LIVE, marks } from './repo.ts';

/** A pass's row at a zone as a scan reads it before its batch; `changed_at` is when it last moved. */
export interface PlaceRow extends PresenceRow {
  due_at: number | null;
  changed_at: number | null;
}

/** The pass's rows at every zone, read with the access zones: an in row moved at entry, an out row at its exit scan. */
export const zoneRowsStmt = (db: D1Database, orgId: string, passId: string): D1PreparedStatement =>
  stmt(
    db,
    `SELECT x.*, CASE WHEN x.state = 'in' THEN x.entered_at ELSE s.at END AS changed_at
     FROM scan_presence x LEFT JOIN scans s ON s.id = x.last_scan_id AND s.org_id = x.org_id
     WHERE x.org_id = ? AND x.pass_id = ? AND x.scope LIKE 'zone:%'`,
    [orgId, passId],
  );

/** The pass's rows at `places`, for a lost entry's reason (run after the batch, in it). */
export const rowsRead = (orgId: string, passId: string, places: readonly string[]): AfterRead =>
  afterRead(
    `SELECT scope, state, due_at, last_entry_at FROM scan_presence
     WHERE org_id = ? AND pass_id = ? AND scope IN (${marks(places.length)})`,
    [orgId, passId, ...places],
  );

/** In now per place: live in rows of passes of this mode. */
export const countsRead = (
  orgId: string,
  mode: string,
  places: readonly string[],
  now: number,
): AfterRead =>
  afterRead(
    `SELECT x.scope AS place, count(*) AS n FROM scan_presence x
     WHERE x.org_id = ? AND x.mode = ? AND x.scope IN (${marks(places.length)}) AND ${LIVE}
     GROUP BY x.scope`,
    [orgId, mode, ...places, now],
  );

export const revsRead = (orgId: string, mode: string, places: readonly string[]): AfterRead =>
  afterRead(
    `SELECT place, rev FROM scan_place_revs WHERE org_id = ? AND mode = ? AND place IN (${marks(places.length)})`,
    [orgId, mode, ...places],
  );

/** Every row of the pass that `group` wrote, for an undo. */
export const groupRowsRead = (orgId: string, passId: string, group: readonly string[]): AfterRead =>
  afterRead(
    `SELECT * FROM scan_presence WHERE org_id = ? AND pass_id = ? AND last_scan_id IN (${marks(group.length)})
     ORDER BY scope`,
    [orgId, passId, ...group],
  );

/** Live inside rows of a place, oldest entry first, after the cursor; and how many there are. */
export function insideReads(
  orgId: string,
  mode: string,
  place: string,
  now: number,
  page: { after: { since: number; passId: string } | null; limit: number },
): [AfterRead, AfterRead] {
  const after = page.after;
  const cursor = after ? 'AND (x.entered_at > ? OR (x.entered_at = ? AND x.pass_id > ?))' : '';
  const params: SqlValue[] = after ? [after.since, after.since, after.passId] : [];
  return [
    afterRead(
      `SELECT x.pass_id AS passId, x.entered_at AS since, x.due_at AS dueAt, s.scanner_id AS via
       FROM scan_presence x LEFT JOIN scans s ON s.id = x.last_scan_id
       WHERE x.org_id = ? AND x.mode = ? AND x.scope = ? AND ${LIVE} ${cursor}
       ORDER BY x.entered_at, x.pass_id LIMIT ?`,
      [orgId, mode, place, now, ...params, page.limit],
    ),
    countsRead(orgId, mode, [place], now),
  ];
}

/** Run reads outside a grant (a preflight or a list). */
export async function runReads(db: D1Database, reads: readonly AfterRead[]): Promise<D1Result[]> {
  if (reads.length === 0) return [];
  return db.batch(reads.map((r) => stmt(db, r.sql, [...r.params])));
}

/** An in row as the cron read it. */
export interface DueRow {
  pass_id: string;
  org_id: string;
  mode: 'live' | 'test';
  scope: string;
  entered_at: number;
  last_entry_at: number;
  last_scan_id: string;
  due_at: number;
  template_id: string;
}

/** The key of one stay in the cron's unsigned-row backoff: a new entry is a new stay. */
export const stayKey = (r: Pick<DueRow, 'pass_id' | 'scope' | 'last_entry_at'>) =>
  `${r.pass_id}:${r.scope}:${r.last_entry_at}`;

/** In rows of active orgs past their due time, oldest first (`scan_presence_due`), but not the `skip` stays. */
export const dueRows = (db: D1Database, now: number, limit: number, skip: readonly string[] = []) =>
  all<DueRow>(
    db,
    `SELECT x.pass_id, x.org_id, x.mode, x.scope, x.entered_at, x.last_entry_at, x.last_scan_id, x.due_at,
            p.template_id
     FROM scan_presence x
     JOIN orgs o ON o.id = x.org_id AND o.status = 'active'
     JOIN passes p ON p.id = x.pass_id
     WHERE x.state = 'in' AND x.due_at IS NOT NULL AND x.due_at <= ? AND x.entered_at IS NOT NULL
       AND (x.pass_id || ':' || x.scope || ':' || x.last_entry_at) NOT IN (SELECT value FROM json_each(?))
     ORDER BY x.due_at LIMIT ?`,
    [now, JSON.stringify(skip), limit],
  );

export interface InRow {
  pass_id: string;
  scope: string;
  entered_at: number;
  last_scan_id: string;
  due_at: number | null;
}

/** In rows at `places` that are live or have no due time: the ones a settings change can move. */
export const movableRows = (
  db: D1Database,
  orgId: string,
  places: readonly string[],
  now: number,
  limit: number,
) =>
  all<InRow>(
    db,
    `SELECT pass_id, scope, entered_at, last_scan_id, due_at FROM scan_presence
     WHERE org_id = ? AND scope IN (${marks(places.length)}) AND state = 'in' AND entered_at IS NOT NULL
       AND (due_at IS NULL OR due_at > ?)
     ORDER BY entered_at LIMIT ?`,
    [orgId, ...places, now, limit],
  );
