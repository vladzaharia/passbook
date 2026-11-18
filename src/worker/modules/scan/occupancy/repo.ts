// Occupancy statements on scan_presence (SA §20.4): one conditional statement decides each entry and exit,
// so racing doors, capacity and nested zones resolve inside the batch. Reads for losers and counts.
import type { Grant, GrantedStatement } from '../../../platform/authority.ts';
import { type AfterRead, afterRead } from '../../../platform/authority-after.ts';
import {
  exists,
  type GrantCond,
  not,
  notExists,
  tenantSql,
} from '../../../platform/authority-cond.ts';
import { gt, inList, orNull } from '../../../platform/authority-expr.ts';
import { type SqlValue, stmt } from '../../../platform/db.ts';
import { allOf } from '../scan-write-statements.ts';

/** A scan_presence row with its due time. */
export interface OccupancyRow {
  pass_id: string;
  scope: string;
  state: 'in' | 'out';
  tracking: number;
  entered_at: number | null;
  first_at: number;
  last_entry_at: number;
  last_scan_id: string;
  due_at: number | null;
  prev_state: string | null;
  prev_tracking: number | null;
  prev_entered_at: number | null;
  prev_first_at: number | null;
  prev_last_entry_at: number | null;
  prev_scan_id: string | null;
}

const LIVE = `x.state = 'in' AND (x.due_at IS NULL OR x.due_at > ?)`;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export const anyOf = (conds: readonly GrantCond[]): GrantCond => not(allOf(conds.map(not)));

/** The pass is inside `place` now: an in row not past its due time. */
export const insideOf = (passId: string, place: string, now: number): GrantCond =>
  tenantSql(
    `EXISTS (SELECT 1 FROM scan_presence x WHERE x.org_id = {org} AND x.pass_id = ? AND x.scope = ? AND ${LIVE})`,
    [passId, place, now],
  );

/** `place` has room for the pass: it is inside already, or fewer than `capacity` passes of this mode are. */
export const roomIn = (passId: string, place: string, capacity: number, now: number): GrantCond =>
  anyOf([
    insideOf(passId, place, now),
    tenantSql(
      `(SELECT count(*) FROM scan_presence x JOIN passes p ON p.id = x.pass_id
        WHERE x.org_id = {org} AND p.org_id = {org} AND p.mode = {mode} AND x.scope = ? AND ${LIVE}) < ?`,
      [place, now, capacity],
    ),
  ]);

/** No entry at `place` after `since` (the re-entry wait). */
export const waitedSince = (passId: string, place: string, since: number): GrantCond =>
  notExists('scan_presence', { pass_id: passId, scope: place, last_entry_at: gt(since) });

/** This scan wrote the row at `place`. */
export const wrote = (passId: string, place: string, scanId: string): GrantCond =>
  exists('scan_presence', { pass_id: passId, scope: place, last_scan_id: scanId });

/** This scan wrote the row at `place` over a row that was in (forced, past due or a track-only repeat). */
export const wroteOverIn = (passId: string, place: string, scanId: string): GrantCond =>
  exists('scan_presence', {
    pass_id: passId,
    scope: place,
    last_scan_id: scanId,
    prev_state: 'in',
  });

/** An in row, live or past due, held by `lastScanId` when given (the cron's compare and swap). */
export const inRow = (passId: string, place: string, lastScanId?: string): GrantCond =>
  exists('scan_presence', {
    pass_id: passId,
    scope: place,
    state: 'in',
    ...(lastScanId ? { last_scan_id: lastScanId } : {}),
  });

const COLUMNS = [
  'pass_id',
  'scope',
  'state',
  'tracking',
  'entered_at',
  'first_at',
  'last_entry_at',
  'last_scan_id',
  'due_at',
];
const PREV = {
  prev_state: 'state',
  prev_tracking: 'tracking',
  prev_entered_at: 'entered_at',
  prev_first_at: 'first_at',
  prev_last_entry_at: 'last_entry_at',
  prev_scan_id: 'last_scan_id',
};

interface RowWrite {
  passId: string;
  place: string;
  scanId: string;
  now: number;
  when: GrantCond[];
}

/**
 * Into `place`: insert, or turn an out (or past-due) row in with a new `since` and due time. `keep`
 * is a track-only repeat over a live in row: `since` and the due time stay.
 */
export function enterRow(
  g: Grant,
  w: RowWrite & { dueAt: number | null; keep?: boolean },
): GrantedStatement {
  const values = [w.passId, w.place, 'in', 1, w.now, w.now, w.now, w.scanId, w.dueAt];
  return g.upsert('scan_presence', COLUMNS, values, {
    when: w.when,
    copy: PREV,
    update: w.keep
      ? ['last_entry_at', 'last_scan_id']
      : ['state', 'tracking', 'entered_at', 'last_entry_at', 'last_scan_id', 'due_at'],
    ...(w.keep ? { where: { state: 'in' } } : {}),
    returning: ['last_scan_id'],
  });
}

/** Out of `place`. `when` must name an existing in row, or the upsert would insert one. */
export function exitRow(g: Grant, w: RowWrite): GrantedStatement {
  const values = [w.passId, w.place, 'out', 1, null, w.now, w.now, w.scanId, null];
  return g.upsert('scan_presence', COLUMNS, values, {
    when: w.when,
    copy: PREV,
    update: ['state', 'entered_at', 'last_scan_id', 'due_at'],
    where: { state: 'in' },
    returning: ['last_scan_id'],
  });
}

/** Raise the place's revision; only ever up. */
export const bumpRev = (g: Grant, place: string, when: GrantCond[]): GrantedStatement =>
  g.upsert('scan_place_revs', ['place', 'rev'], [place, 1], {
    when,
    inc: ['rev'],
    returning: ['rev'],
  });

/** Undo one row a scan wrote: delete what it inserted, else put the previous values back. */
export function undoRow(g: Grant, row: OccupancyRow, dueAt: number | null): GrantedStatement {
  const key = {
    pass_id: row.pass_id,
    scope: row.scope,
    last_scan_id: row.last_scan_id,
    state: row.state,
  };
  if (row.prev_state === null)
    return g.delete('scan_presence', {
      where: { ...key, prev_state: null },
      require: 'one',
      returning: ['pass_id'],
    });
  return g.update('scan_presence', {
    set: {
      state: row.prev_state,
      tracking: row.prev_tracking,
      entered_at: row.prev_entered_at,
      first_at: row.prev_first_at,
      last_entry_at: row.prev_last_entry_at,
      last_scan_id: row.prev_scan_id,
      due_at: dueAt,
      prev_state: null,
      prev_tracking: null,
      prev_entered_at: null,
      prev_first_at: null,
      prev_last_entry_at: null,
      prev_scan_id: null,
    },
    where: {
      ...key,
      prev_state: row.prev_state,
      prev_tracking: row.prev_tracking,
      prev_entered_at: row.prev_entered_at,
      prev_first_at: row.prev_first_at,
      prev_last_entry_at: row.prev_last_entry_at,
      prev_scan_id: row.prev_scan_id,
    },
    require: 'one',
    returning: ['pass_id'],
  });
}

/**
 * The undo still applies whole: the pass has exactly `count` rows written by the group, and no row
 * of the pass at any place was written by a scan after `after`.
 */
export function undoStillApplies(
  passId: string,
  group: readonly string[],
  count: number,
  after: { at: number; id: string },
): GrantCond[] {
  const ids = marks(group.length);
  return [
    not(
      tenantSql(
        `EXISTS (SELECT 1 FROM scan_presence x JOIN scans s ON s.id = x.last_scan_id
          WHERE x.org_id = {org} AND s.org_id = {org} AND x.pass_id = ? AND x.last_scan_id NOT IN (${ids})
            AND (s.at > ? OR (s.at = ? AND s.id > ?)))`,
        [passId, ...group, after.at, after.at, after.id],
      ),
    ),
    tenantSql(
      `(SELECT count(*) FROM scan_presence x WHERE x.org_id = {org} AND x.pass_id = ? AND x.last_scan_id IN (${ids})) = ?`,
      [passId, ...group, count],
    ),
  ];
}

/** A zone stopped tracking, was archived or moved: its inside rows fall due now (the cron closes them). */
export function dueNow(g: Grant, places: readonly string[], now: number): GrantedStatement[] {
  const out: GrantedStatement[] = [];
  for (let i = 0; i < places.length; i += 20)
    out.push(
      g.update('scan_presence', {
        set: { due_at: now },
        where: { scope: inList(places.slice(i, i + 20)), state: 'in', due_at: orNull(gt(now)) },
      }),
    );
  return out;
}

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
    `SELECT x.scope AS place, count(*) AS n FROM scan_presence x JOIN passes p ON p.id = x.pass_id
     WHERE x.org_id = ? AND p.org_id = ? AND p.mode = ? AND x.scope IN (${marks(places.length)})
       AND ${LIVE} GROUP BY x.scope`,
    [orgId, orgId, mode, ...places, now],
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
       FROM scan_presence x JOIN passes p ON p.id = x.pass_id LEFT JOIN scans s ON s.id = x.last_scan_id
       WHERE x.org_id = ? AND p.org_id = ? AND p.mode = ? AND x.scope = ? AND ${LIVE} ${cursor}
       ORDER BY x.entered_at, x.pass_id LIMIT ?`,
      [orgId, orgId, mode, place, now, ...params, page.limit],
    ),
    countsRead(orgId, mode, [place], now),
  ];
}

/** Run reads outside a grant (a preflight or a list). */
export async function runReads(db: D1Database, reads: readonly AfterRead[]): Promise<D1Result[]> {
  if (reads.length === 0) return [];
  return db.batch(reads.map((r) => stmt(db, r.sql, [...r.params])));
}
