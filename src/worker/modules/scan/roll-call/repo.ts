// Roll call reads (PS-33). Writes go through a grant in service.ts.
import { all, first } from '../../../platform/db.ts';

export interface PlaceInfo {
  place: string;
  name: string;
  basis: 'in_now' | 'tapped_in';
}

export interface SnapshotPerson {
  passId: string;
  holder: string | null;
  plan: string | null;
  host: string | null;
  place: string;
  since: number;
}

export interface CallRow {
  id: string;
  scopeKey: string;
  places: PlaceInfo[];
  snapshot: SnapshotPerson[];
  startedBy: string;
  startedAt: number;
  endedAt: number | null;
  endedBy: string | null;
  rev: number;
}

interface RawCall {
  id: string;
  scope_key: string;
  places: string;
  snapshot: string;
  started_by: string;
  started_at: number;
  ended_at: number | null;
  ended_by: string | null;
  rev: number;
}

const COLS = `id, scope_key, places, snapshot, started_by, started_at, ended_at, ended_by, rev`;

const toCall = (r: RawCall): CallRow => ({
  id: r.id,
  scopeKey: r.scope_key,
  places: JSON.parse(r.places) as PlaceInfo[],
  snapshot: JSON.parse(r.snapshot) as SnapshotPerson[],
  startedBy: r.started_by,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  endedBy: r.ended_by,
  rev: r.rev,
});

export async function openCall(
  db: D1Database,
  orgId: string,
  mode: string,
  scopeKey: string,
): Promise<CallRow | null> {
  const r = await first<RawCall>(
    db,
    `SELECT ${COLS} FROM roll_calls WHERE org_id = ? AND mode = ? AND scope_key = ? AND ended_at IS NULL`,
    [orgId, mode, scopeKey],
  );
  return r ? toCall(r) : null;
}

export async function callById(
  db: D1Database,
  orgId: string,
  mode: string,
  id: string,
): Promise<CallRow | null> {
  const r = await first<RawCall>(
    db,
    `SELECT ${COLS} FROM roll_calls WHERE org_id = ? AND mode = ? AND id = ?`,
    [orgId, mode, id],
  );
  return r ? toCall(r) : null;
}

export interface MarkRow {
  passId: string;
  status: 'present' | 'out' | 'none';
  by: string;
  at: number;
  late: SnapshotPerson | null;
}

export const marksOf = (db: D1Database, orgId: string, mode: string, id: string) =>
  all<Omit<MarkRow, 'late'> & { late: string | null }>(
    db,
    `SELECT pass_id AS passId, status, by_name AS "by", marked_at AS at, late FROM roll_call_marks
     WHERE roll_call_id = ? AND org_id = ? AND mode = ?`,
    [id, orgId, mode],
  ).then((rows) =>
    rows.map(({ late, ...r }) => ({
      ...r,
      late: late ? (JSON.parse(late) as SnapshotPerson) : null,
    })),
  );

export interface PresenceNow {
  passId: string;
  place: string;
  state: string;
  dueAt: number | null;
  outCause: string | null;
}

/** Where each pass stands now at the call's places: inside, left, or closed by the clock. */
export const presenceNow = (
  db: D1Database,
  orgId: string,
  mode: string,
  passIds: readonly string[],
  places: readonly string[],
) =>
  all<PresenceNow>(
    db,
    `SELECT x.pass_id AS passId, x.scope AS place, x.state, x.due_at AS dueAt, s.out_cause AS outCause
     FROM scan_presence x LEFT JOIN scans s ON s.id = x.last_scan_id
     WHERE x.org_id = ? AND x.mode = ? AND x.pass_id IN (SELECT value FROM json_each(?))
       AND x.scope IN (SELECT value FROM json_each(?))`,
    [orgId, mode, JSON.stringify(passIds), JSON.stringify(places)],
  );

/** Open calls whose places hold Max stay and Clear at exits, for the cron. */
export const heldPlaces = (db: D1Database, now: number, horizonMs: number) =>
  all<{ org_id: string; mode: string; places: string }>(
    db,
    `SELECT org_id, mode, places FROM roll_calls WHERE ended_at IS NULL AND started_at > ?`,
    [now - horizonMs],
  );
