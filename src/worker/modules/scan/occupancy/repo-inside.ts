// Who's in: live in rows across a set of places, one row per pass at its deepest place (SA §20.9).
import { type AfterRead, afterRead } from '../../../platform/authority-after.ts';
import type { SqlValue } from '../../../platform/db.ts';
import { marks } from './repo.ts';

const LIVE_X = `x.state = 'in' AND (x.due_at IS NULL OR x.due_at > ?)`;
const LIVE_Y = `y.state = 'in' AND (y.due_at IS NULL OR y.due_at > ?)`;

export interface InsideCursor {
  since: number;
  passId: string;
  place: string;
}

export interface InsideRead {
  orgId: string;
  mode: string;
  places: readonly string[];
  /** child place -> parent place, both in scope: a pass inside a child is listed there only. */
  nested: Readonly<Record<string, string>>;
  now: number;
}

/** Live rows, longest inside first, after the cursor. `nested` hides a row whose child place also holds the pass. */
export function insideRowsRead(
  q: InsideRead,
  after: InsideCursor | null,
  limit: number,
): AfterRead {
  const cursor = after
    ? `AND (x.entered_at > ? OR (x.entered_at = ? AND (x.pass_id > ? OR (x.pass_id = ? AND x.scope > ?))))`
    : '';
  const params: SqlValue[] = after
    ? [after.since, after.since, after.passId, after.passId, after.place]
    : [];
  return afterRead(
    `SELECT x.pass_id AS passId, x.scope AS place, x.entered_at AS since, x.due_at AS dueAt, sc.name AS via
     FROM scan_presence x
     LEFT JOIN scans s ON s.id = x.last_scan_id
     LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = x.org_id
     WHERE x.org_id = ? AND x.mode = ? AND x.scope IN (${marks(q.places.length)}) AND ${LIVE_X}
       AND NOT EXISTS (SELECT 1 FROM json_each(?) m JOIN scan_presence y
         ON y.org_id = x.org_id AND y.pass_id = x.pass_id AND y.scope = m.key
         WHERE m.value = x.scope AND ${LIVE_Y})
       ${cursor}
     ORDER BY x.entered_at, x.pass_id, x.scope LIMIT ?`,
    [q.orgId, q.mode, ...q.places, q.now, JSON.stringify(q.nested), q.now, ...params, limit],
  );
}

/** How many distinct passes are inside any of the places now. */
export const insideDistinctRead = (q: Omit<InsideRead, 'nested'>): AfterRead =>
  afterRead(
    `SELECT count(DISTINCT x.pass_id) AS n FROM scan_presence x
     WHERE x.org_id = ? AND x.mode = ? AND x.scope IN (${marks(q.places.length)}) AND ${LIVE_X}`,
    [q.orgId, q.mode, ...q.places, q.now],
  );

/** The pass's row at a place, to see whether it is inside and since when. */
export const presenceRead = (orgId: string, passId: string, place: string): AfterRead =>
  afterRead(
    `SELECT state, entered_at AS enteredAt, due_at AS dueAt, last_scan_id AS lastScanId FROM scan_presence
     WHERE org_id = ? AND pass_id = ? AND scope = ?`,
    [orgId, passId, place],
  );

/** Console names: the pass's own title and standing. */
export const passTitlesRead = (orgId: string, mode: string, ids: readonly string[]): AfterRead =>
  afterRead(
    `SELECT p.id, p.display_title AS title, t.name AS type, p.status, p.removed_at AS removedAt,
       p.deleted_at AS deletedAt
     FROM passes p LEFT JOIN templates t ON t.id = p.template_id AND (t.org_id IS NULL OR t.org_id = p.org_id)
     WHERE p.org_id = ? AND p.mode = ? AND p.id IN (${marks(ids.length)})`,
    [orgId, mode, ...ids],
  );

/** An event as a place: its name, capacity and whether it tracks exits. */
export const eventPlaceRead = (orgId: string, mode: string, id: string): AfterRead =>
  afterRead(
    `SELECT name, capacity, reentry FROM scan_events
     WHERE org_id = ? AND mode = ? AND id = ? AND archived_at IS NULL`,
    [orgId, mode, id],
  );
