// Occupancy statements on scan_presence (SA §20.4): one conditional statement decides each entry and exit,
// so racing doors, capacity and nested zones resolve inside the batch. Reads for losers and counts.
import type { Grant, GrantedStatement } from '../../../platform/authority.ts';
import {
  exists,
  type GrantCond,
  not,
  notExists,
  tenantSql,
} from '../../../platform/authority-cond.ts';
import { gt, inList, orNull } from '../../../platform/authority-expr.ts';
import { RACE_PRESENCE_WRITE } from '../race-tags.ts';
import { allOf } from '../scan-write-statements.ts';
import type { ZoneFence } from './rules.ts';

/** A scan_presence row with its due time and commit sequence. */
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
  seq: number;
  prev_seq: number | null;
}

export const LIVE = `x.state = 'in' AND (x.due_at IS NULL OR x.due_at > ?)`;
/** Who moved a row last: the scanner and the person signed in on it, from the scan that wrote it (`s`). */
export const VIA_JOIN = `LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = x.org_id
     LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = x.org_id`;
export const VIA_SQL = `CASE WHEN sc.name IS NOT NULL AND st.name IS NOT NULL THEN sc.name || ' · ' || st.name
       ELSE COALESCE(sc.name, st.name) END`;
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export const anyOf = (conds: readonly GrantCond[]): GrantCond => not(allOf(conds.map(not)));

/** The pass is inside `place` now: an in row not past its due time. */
export const insideOf = (passId: string, place: string, now: number): GrantCond =>
  tenantSql(
    `EXISTS (SELECT 1 FROM scan_presence x WHERE x.org_id = {org} AND x.mode = {mode} AND x.pass_id = ? AND x.scope = ?
        AND ${LIVE})`,
    [passId, place, now],
  );

/** `place` has room for the pass: it is inside already, or fewer than `capacity` passes of this mode are. */
export const roomIn = (passId: string, place: string, capacity: number, now: number): GrantCond =>
  anyOf([
    insideOf(passId, place, now),
    tenantSql(
      `(SELECT count(*) FROM scan_presence x
        WHERE x.org_id = {org} AND x.mode = {mode} AND x.scope = ? AND ${LIVE}) < ?`,
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

/** The zone is still as the plan read it: same tracking, parent, archive state and Hard limit. */
export const zoneIs = (z: ZoneFence): GrantCond =>
  exists('scan_zones', {
    id: z.id,
    occupancy: z.occupancy,
    parent_id: z.parentId,
    archived_at: z.archivedAt,
    // A Hard limit set after the read stops this admission: the commit never admits past it.
    hard_limit: z.hardLimit ? 1 : 0,
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
    tag: RACE_PRESENCE_WRITE,
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
    tag: RACE_PRESENCE_WRITE,
    copy: PREV,
    update: ['state', 'tracking', 'entered_at', 'last_scan_id', 'due_at'],
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

/** Put an in row on a recomputed due time; it holds only while no scan has touched the row since it was read. */
export const setDue = (
  g: Grant,
  r: { passId: string; place: string; lastScanId: string },
  due: number | null,
): GrantedStatement =>
  g.update('scan_presence', {
    set: { due_at: due },
    where: { pass_id: r.passId, scope: r.place, last_scan_id: r.lastScanId, state: 'in' },
  });
