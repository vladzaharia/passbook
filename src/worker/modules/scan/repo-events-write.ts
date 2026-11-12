import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { tenantSql } from '../../platform/authority-cond.ts';
import { inList, maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, stmt } from '../../platform/db.ts';
import { eventScannersAre, eventSessionsAre } from './repo-admin-grant.ts';
import { clearTemplatesOfScanners } from './repo-admin-unguarded.ts';

type Db = D1Database;

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

/** org_id and mode come from the grant row. */
export const addEventInsert = (
  g: Grant,
  e: EventValues,
  createdBy: string,
  now: number,
): GrantedStatement =>
  g.insertSelect(
    'scan_events',
    [
      'id',
      'name',
      'match_input',
      'match_values',
      'opens_at',
      'closes_at',
      'time_zone',
      'capacity',
      'reentry',
      'note',
      'created_by',
      'created_at',
      'updated_at',
    ],
    [
      e.id,
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

/** Only the fields the edit names: a concurrent edit of another field survives. */
interface EventPatch {
  name?: string;
  match?: { input: string; values: string[] } | null;
  opensAt?: number;
  closesAt?: number;
  timeZone?: string;
  capacity?: number | null;
  reentry?: boolean;
  note?: string | null;
}

/** Drops the cached `expected` (volatile), so the next read recounts. */
export function addEventUpdate(g: Grant, id: string, p: EventPatch, now: number): GrantedStatement {
  const set: Record<string, SetValue> = {
    expected: null,
    expected_at: null,
    updated_at: maxNow(now),
  };
  if (p.name !== undefined) set.name = p.name;
  if (p.match !== undefined) {
    set.match_input = p.match?.input ?? null;
    set.match_values = p.match ? JSON.stringify(p.match.values) : null;
  }
  if (p.opensAt !== undefined) set.opens_at = p.opensAt;
  if (p.closesAt !== undefined) set.closes_at = p.closesAt;
  if (p.timeZone !== undefined) set.time_zone = p.timeZone;
  if (p.capacity !== undefined) set.capacity = p.capacity;
  if (p.reentry !== undefined) set.reentry = p.reentry ? 1 : 0;
  if (p.note !== undefined) set.note = p.note;
  return g.update('scan_events', { set, where: { id }, require: 'one' });
}

/** A new event has no links; an existing one is cleared first. The event is in the grant's org. */
export function addEventTemplates(
  g: Grant,
  eventId: string,
  templateIds: readonly string[],
  replace: boolean,
): GrantedStatement[] {
  const out: GrantedStatement[] = [];
  if (replace)
    out.push(g.joined('scan_event_templates', { where: { event_id: eventId }, delete: true }));
  for (const id of templateIds)
    out.push(
      g.insertJoined('scan_event_templates', {
        parents: { event_id: eventId },
        columns: ['template_id'],
        values: [id],
      }),
    );
  return out;
}

/** The scanners and sessions an archive detaches, as read for the edit. */
export interface EventDependents {
  scanners: { id: string; settings: string }[];
  sessions: { id: string; settings: string }[];
}

const closedOpen = (settings: string): string =>
  JSON.stringify({ ...(JSON.parse(settings) as object), acceptAllTemplates: false });

/** Archiving ends the event for every scanner on it: they read as `unassigned` and refetch. */
export function addEventArchive(
  g: Grant,
  id: string,
  dependents: EventDependents,
  now: number,
): GrantedStatement[] {
  const out: GrantedStatement[] = [
    g.update('scan_events', {
      set: { archived_at: now, updated_at: maxNow(now) },
      where: { id, archived_at: null },
      require: 'one',
    }),
  ];
  for (const session of dependents.sessions)
    out.push(
      g.update('scanning_sessions', {
        set: { accepts: null, settings: closedOpen(session.settings), updated_at: maxNow(now) },
        where: { id: session.id },
      }),
    );
  // The grant checks the event's scanners are exactly `dependents.scanners`.
  out.push(
    ...clearTemplatesOfScanners(
      g,
      dependents.scanners.map((scanner) => scanner.id),
    ),
  );
  for (const scanner of dependents.scanners)
    out.push(
      g.update('scanners', {
        set: { event_id: null, settings: closedOpen(scanner.settings), updated_at: maxNow(now) },
        where: { id: scanner.id },
      }),
    );
  return out;
}

export const addEventRestore = (g: Grant, id: string, now: number): GrantedStatement =>
  g.update('scan_events', {
    set: { archived_at: null, updated_at: maxNow(now) },
    where: { id },
    require: 'one',
  });

/** Cache fill only: the recount is volatile, so it never moves the event's epoch. */
export const addEventCache = (
  g: Grant,
  id: string,
  expected: number,
  now: number,
): GrantedStatement =>
  g.update('scan_events', {
    set: { expected, expected_at: now },
    where: { id },
    require: 'one',
  });

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
     WHERE org_id = ? AND revoked_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    [orgId, JSON.stringify(ids)],
  );
  return rows.map((r) => ({ id: r.id, mode: r.mode, kind: r.kind, deviceRole: r.device_role }));
}

/** Moves scanners onto the event (all of them or the batch aborts); their own template list no longer applies. */
export function addEventAssign(
  g: Grant,
  eventId: string,
  ids: readonly string[],
  now: number,
): GrantedStatement[] {
  const out: GrantedStatement[] = [
    // The touch proves the event is in the grant's org before anything hangs off it.
    g.update('scan_events', {
      set: { updated_at: maxNow(now) },
      where: { id: eventId },
      require: 'one',
    }),
  ];
  // The ids are proven by `scannersAssignable`; `in` takes at most 20 per statement.
  for (let at = 0; at < ids.length; at += 20)
    out.push(
      g.update('scanners', {
        set: { event_id: eventId, updated_at: maxNow(now) },
        where: { id: inList(ids.slice(at, at + 20)) },
        returning: ['id'],
      }),
    );
  // Every scanner took the event, or the batch aborts: no partial move, no template loss, no false audit.
  out.push(
    g.assert('config', [
      tenantSql(
        `(SELECT count(*) FROM scanners s WHERE s.org_id = {org} AND s.mode = {mode} AND s.event_id = ?
          AND s.id IN (SELECT value FROM json_each(?))) = ?`,
        [eventId, JSON.stringify(ids), ids.length],
      ),
    ]),
  );
  out.push(...clearTemplatesOfScanners(g, ids));
  return out;
}

/** The scanners and standalone sessions that point at the event, for an archive. */
export async function eventDependents(
  db: Db,
  orgId: string,
  mode: Mode,
  eventId: string,
): Promise<EventDependents> {
  const [scanners, sessions] = await db.batch([
    stmt(
      db,
      'SELECT id, settings FROM scanners WHERE event_id = ? AND org_id = ? AND mode = ? ORDER BY id',
      [eventId, orgId, mode],
    ),
    stmt(
      db,
      "SELECT id, settings FROM scanning_sessions WHERE json_extract(accepts, '$.eventId') = ? AND org_id = ? AND mode = ? ORDER BY id",
      [eventId, orgId, mode],
    ),
  ]);
  return {
    scanners: (scanners?.results ?? []) as EventDependents['scanners'],
    sessions: (sessions?.results ?? []) as EventDependents['sessions'],
  };
}

/** The dependents of an archive are still exactly the set that was read. */
export const eventArchiveChecks = (id: string, d: EventDependents): Check[] => [
  eventScannersAre(
    id,
    d.scanners.map((s) => s.id),
  ),
  eventSessionsAre(
    id,
    d.sessions.map((s) => s.id),
  ),
];
