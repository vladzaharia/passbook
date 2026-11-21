import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { inList, maxNow, type SetValue } from '../../platform/authority-expr.ts';
import { all, first, type SqlValue } from '../../platform/db.ts';
import { tagged } from './setup-check-merge.ts';

type Db = D1Database;

export interface ZoneRow {
  id: string;
  orgId: string;
  key: string;
  name: string;
  parentId: string | null;
  timeZone: string | null;
  sort: number;
  occupancy: 'off' | 'track' | 'enforce';
  capacity: number | null;
  maxStayMinutes: number | null;
  clearAt: string | null;
  hardLimit: boolean;
  archivedAt: number | null;
  updatedAt: number;
  /** Sessions that check this zone. */
  sessions: number;
}

interface Raw {
  id: string;
  org_id: string;
  key: string;
  name: string;
  parent_id: string | null;
  time_zone: string | null;
  sort: number;
  occupancy: ZoneRow['occupancy'];
  capacity: number | null;
  max_stay_minutes: number | null;
  clear_at: string | null;
  hard_limit: number;
  archived_at: number | null;
  updated_at: number;
  sessions: number;
}

const SELECT = `SELECT z.id, z.org_id, z.key, z.name, z.parent_id, z.time_zone, z.sort, z.occupancy,
    z.capacity, z.max_stay_minutes, z.clear_at, z.hard_limit, z.archived_at, z.updated_at,
    (SELECT count(*) FROM scanning_session_zones l WHERE l.zone_id = z.id) AS sessions
  FROM scan_zones z`;

const toRow = (r: Raw): ZoneRow => ({
  id: r.id,
  orgId: r.org_id,
  key: r.key,
  name: r.name,
  parentId: r.parent_id,
  timeZone: r.time_zone,
  sort: r.sort,
  occupancy: r.occupancy,
  capacity: r.capacity,
  maxStayMinutes: r.max_stay_minutes,
  clearAt: r.clear_at,
  hardLimit: r.hard_limit === 1,
  archivedAt: r.archived_at,
  updatedAt: r.updated_at,
  sessions: r.sessions,
});

/** Every zone of the org, archived or not: the tree is small and its rules need all of it. */
export async function orgZoneRows(db: Db, orgId: string): Promise<ZoneRow[]> {
  const rows = await all<Raw>(db, `${SELECT} WHERE z.org_id = ? ORDER BY z.sort, z.name, z.id`, [
    orgId,
  ]);
  return rows.map(toRow);
}

/** The sessions of the org in this mode that check each zone, by zone id, in name order. */
export async function checkedAtByZone(
  db: Db,
  orgId: string,
  mode: 'live' | 'test',
): Promise<Map<string, { id: string; name: string }[]>> {
  const rows = await all<{ zone_id: string; id: string; name: string }>(
    db,
    `SELECT l.zone_id, s.id, s.name FROM scanning_session_zones l
     JOIN scanning_sessions s ON s.id = l.session_id
     WHERE s.org_id = ? AND s.mode = ? AND s.status != 'ended' ORDER BY s.name, s.id`,
    [orgId, mode],
  );
  const out = new Map<string, { id: string; name: string }[]>();
  for (const r of rows)
    out.set(r.zone_id, [...(out.get(r.zone_id) ?? []), { id: r.id, name: r.name }]);
  return out;
}

export async function zoneRow(db: Db, orgId: string, id: string): Promise<ZoneRow | null> {
  const r = await first<Raw>(db, `${SELECT} WHERE z.id = ? AND z.org_id = ?`, [id, orgId]);
  return r ? toRow(r) : null;
}

/** The zone's org, before any tenant authority exists for it. */
export const zoneTarget = (db: Db, id: string) =>
  first<{ orgId: string }>(db, 'SELECT org_id AS orgId FROM scan_zones WHERE id = ?', [id]);

/** The zones of `ids` that belong to the org, and whether each is archived. */
export async function zonesInOrg(
  db: Db,
  orgId: string,
  ids: readonly string[],
): Promise<{ id: string; archived: boolean }[]> {
  if (ids.length === 0) return [];
  const rows = await all<{ id: string; archived_at: number | null }>(
    db,
    `SELECT id, archived_at FROM scan_zones WHERE org_id = ? AND id IN (SELECT value FROM json_each(?))`,
    [orgId, JSON.stringify(ids)],
  );
  return rows.map((r) => ({ id: r.id, archived: r.archived_at !== null }));
}

/** The zones a session checks, in order. Scoped by the session's org. */
export async function sessionZoneIds(db: Db, orgId: string, sessionId: string): Promise<string[]> {
  const rows = await all<{ zone_id: string }>(
    db,
    `SELECT l.zone_id FROM scanning_session_zones l
     JOIN scanning_sessions s ON s.id = l.session_id
     JOIN scan_zones z ON z.id = l.zone_id AND z.org_id = s.org_id
     WHERE l.session_id = ? AND s.org_id = ? ORDER BY l.sort, l.zone_id`,
    [sessionId, orgId],
  );
  return rows.map((r) => r.zone_id);
}

export interface ZoneInsert {
  id: string;
  key: string;
  name: string;
  parentId: string | null;
  timeZone: string | null;
  sort: number;
  occupancy: ZoneRow['occupancy'];
  capacity: number | null;
  maxStayMinutes: number | null;
  clearAt: string | null;
  hardLimit: boolean;
}

/** org_id comes from the grant row. */
export const addZoneInsert = (
  g: Grant,
  z: ZoneInsert,
  createdBy: string | null,
  now: number,
): GrantedStatement =>
  g.insertSelect(
    'scan_zones',
    [
      'id',
      'key',
      'name',
      'parent_id',
      'time_zone',
      'sort',
      'occupancy',
      'capacity',
      'max_stay_minutes',
      'clear_at',
      'hard_limit',
      'created_by',
      'created_at',
      'updated_at',
    ],
    [
      z.id,
      z.key,
      z.name,
      z.parentId,
      z.timeZone,
      z.sort,
      z.occupancy,
      z.capacity,
      z.maxStayMinutes,
      z.clearAt,
      z.hardLimit ? 1 : 0,
      createdBy,
      now,
      now,
    ],
  );

export interface ZonePatch {
  name?: string;
  parentId?: string | null;
  timeZone?: string | null;
  sort?: number;
  occupancy?: ZoneRow['occupancy'];
  capacity?: number | null;
  maxStayMinutes?: number | null;
  clearAt?: string | null;
  hardLimit?: boolean;
}

/** Only the fields the edit names: a concurrent edit of another field survives. */
export function addZoneUpdate(g: Grant, id: string, p: ZonePatch, now: number): GrantedStatement {
  const set: Record<string, SetValue> = { updated_at: maxNow(now) };
  if (p.name !== undefined) set.name = p.name;
  if (p.parentId !== undefined) set.parent_id = p.parentId;
  if (p.timeZone !== undefined) set.time_zone = p.timeZone;
  if (p.sort !== undefined) set.sort = p.sort;
  if (p.occupancy !== undefined) set.occupancy = p.occupancy;
  if (p.capacity !== undefined) set.capacity = p.capacity;
  if (p.maxStayMinutes !== undefined) set.max_stay_minutes = p.maxStayMinutes;
  if (p.clearAt !== undefined) set.clear_at = p.clearAt;
  if (p.hardLimit !== undefined) set.hard_limit = p.hardLimit ? 1 : 0;
  return g.update('scan_zones', { set, where: { id }, require: 'one' });
}

/** Archive or restore these zones (a zone and the zones below it); `in` takes 20 ids at most. */
export function addZoneArchive(
  g: Grant,
  ids: readonly string[],
  archivedAt: number | null,
  now: number,
): GrantedStatement[] {
  const out: GrantedStatement[] = [];
  for (let at = 0; at < ids.length; at += 20)
    out.push(
      g.update('scan_zones', {
        set: { archived_at: archivedAt, updated_at: maxNow(now) },
        where: {
          id: inList(ids.slice(at, at + 20) as SqlValue[]),
          ...(archivedAt === null ? {} : { archived_at: null }),
        },
      }),
    );
  return out;
}

/** Every zone is in the grant's org and not archived (the body names ids; the grant proves them). */
export const zonesOpen = (ids: readonly string[]): Check[] =>
  ids.length === 0
    ? []
    : [
        tagged(
          tenantCheck(
            'config',
            `NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM scan_zones z
            WHERE z.id = j.value AND z.archived_at IS NULL AND z.org_id = {org}))`,
            [JSON.stringify([...new Set(ids)])],
          ),
          'zones',
          [...new Set(ids)],
        ),
      ];

/** The zone and the zones below it are exactly these ids, in the grant's org. */
export const zoneSubtreeIs = (id: string, ids: readonly string[]): Check =>
  tenantCheck(
    'config',
    `(SELECT COALESCE(group_concat(x.id), '') FROM (WITH RECURSIVE t(id) AS (
        SELECT r.id FROM scan_zones r WHERE r.id = ? AND r.org_id = {org}
        UNION ALL SELECT z.id FROM scan_zones z JOIN t ON z.parent_id = t.id WHERE z.org_id = {org})
      SELECT id FROM t ORDER BY id) x) = ?`,
    [id, [...ids].sort().join(',')],
  );

/**
 * The zone may sit under the parent at commit: not inside its own subtree and within the depth
 * limit. The service checks the same rules on a read; this is the backstop for a racing move.
 * `id` may be a zone that does not exist yet.
 */
export const zoneFitsUnder = (id: string, parentId: string): Check =>
  tenantCheck(
    'config',
    `(WITH RECURSIVE down(id, h) AS (
        SELECT r.id, 0 FROM scan_zones r WHERE r.id = ? AND r.org_id = {org}
        UNION ALL SELECT z.id, d.h + 1 FROM scan_zones z JOIN down d ON z.parent_id = d.id WHERE z.org_id = {org}),
      up(id, parent_id, d) AS (
        SELECT r.id, r.parent_id, 0 FROM scan_zones r WHERE r.id = ? AND r.org_id = {org}
        UNION ALL SELECT z.id, z.parent_id, u.d + 1 FROM scan_zones z JOIN up u ON z.id = u.parent_id WHERE z.org_id = {org})
      SELECT NOT EXISTS (SELECT 1 FROM down WHERE id = ?)
        AND COALESCE((SELECT max(d) FROM up), -1) + 1 + COALESCE((SELECT max(h) FROM down), 0) <= 3)`,
    [id, parentId, parentId],
  );

/** A new set of links for the session. The session and every zone are proven by the grant. */
export function addSessionZones(
  g: Grant,
  sessionId: string,
  zoneIds: readonly string[],
  replace: boolean,
): GrantedStatement[] {
  const out: GrantedStatement[] = [];
  if (replace)
    out.push(
      g.joined('scanning_session_zones', { where: { session_id: sessionId }, delete: true }),
    );
  zoneIds.forEach((zoneId, sort) => {
    out.push(
      g.insertJoined('scanning_session_zones', {
        parents: { session_id: sessionId, zone_id: zoneId },
        columns: ['sort'],
        values: [sort],
      }),
    );
  });
  return out;
}
