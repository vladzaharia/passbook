import type { ZoneNode } from '../../../passkit/template/access/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { type Check, exactlyOne } from '../../platform/authority-checks.ts';
import { exists, type GrantCond } from '../../platform/authority-cond.ts';
import { gte, lt, lte, ne, orNull } from '../../platform/authority-expr.ts';
import { all, first, stmt } from '../../platform/db.ts';
import type { AccessTemplateRow } from './zones-plans.ts';

/** An org's zone tree is small; past this many zones the read stops (the rest grant nothing). */
export const ACCESS_ZONE_LIMIT = 1000;

/** The visit gate: one row per pass, the literal `access` for both the action and the scope. */
export const ACCESS_GATE = 'access';

interface ZoneRaw {
  id: string;
  key: string;
  name: string;
  parent_id: string | null;
  time_zone: string | null;
  archived_at: number | null;
}

/** The org's zones, archived ones included, for the evaluator. Read with the preflight. */
export const orgZonesStmt = (db: D1Database, orgId: string): D1PreparedStatement =>
  stmt(
    db,
    `SELECT id, key, name, parent_id, time_zone, archived_at FROM scan_zones
     WHERE org_id = ? ORDER BY sort, id LIMIT ${ACCESS_ZONE_LIMIT}`,
    [orgId],
  );

/** The zones the session checks, in its order, scoped by the session's org. */
export const sessionZonesStmt = (
  db: D1Database,
  orgId: string,
  sessionId: string,
): D1PreparedStatement =>
  stmt(
    db,
    `SELECT l.zone_id AS zone_id FROM scanning_session_zones l
     JOIN scanning_sessions s ON s.id = l.session_id AND s.org_id = ?
     WHERE l.session_id = ? ORDER BY l.sort, l.zone_id`,
    [orgId, sessionId],
  );

export const zoneNodes = (result: D1Result | undefined): ZoneNode[] =>
  ((result?.results ?? []) as unknown as ZoneRaw[]).map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    parentId: r.parent_id,
    timeZone: r.time_zone,
    archived: r.archived_at !== null,
  }));

export const zoneIdsOf = (result: D1Result | undefined): string[] =>
  ((result?.results ?? []) as unknown as { zone_id: string }[]).map((r) => r.zone_id);

/** The visit gate's count after the commit: `used` for the answer. */
export const accessCountStmt = (db: D1Database, passId: string): D1PreparedStatement =>
  stmt(db, `SELECT count FROM scan_gates WHERE pass_id = ? AND action_id = ? AND scope = ?`, [
    passId,
    ACCESS_GATE,
    ACCESS_GATE,
  ]);

/** The deciding zone is still live and still one of the session's, at commit (C6). */
export const accessZoneChecks = (zoneId: string | null, sessionId: string | null): Check[] =>
  zoneId === null
    ? []
    : [
        exactlyOne('scan_zones', { id: zoneId, archived_at: null }, undefined, 'config'),
        ...(sessionId === null
          ? []
          : [
              exactlyOne(
                'scanning_session_zones',
                { session_id: sessionId, zone_id: zoneId },
                'session_id',
                'config',
              ),
            ]),
      ];

export interface AccessGateWrite {
  passId: string;
  templateId: string;
  scanId: string;
  at: number;
  /** Grants within this long of the last are one visit; 0: every grant is a visit. */
  gapMs: number;
  /** A grant within this long of the last is held; null: off. */
  waitMs: number | null;
  /** The guest's visit limit; null: none. */
  limit: number | null;
  /** A Manager let this scan through: the wait and the limit are skipped. */
  override?: boolean;
}

const COLUMNS = [
  'pass_id',
  'action_id',
  'scope',
  'template_id',
  'kind',
  'state',
  'count',
  'first_at',
  'last_at',
  'last_scan_id',
];

/**
 * The visit gate in the grant (AX 3.5). A new visit counts and meets the limit and the wait; a
 * grant inside the gap leaves the count alone, so racing scans of a guest with one visit left both
 * pass and the count rises once. Exactly one statement writes the row (`last_scan_id`), and the
 * first grant ever inserts it.
 */
export function writeAccessGate(
  g: Grant,
  w: AccessGateWrite,
  when: GrantCond[],
): { visit: GrantedStatement; sameVisit: GrantedStatement | null } {
  const key = { pass_id: w.passId, action_id: ACCESS_GATE, scope: ACCESS_GATE };
  const values = [
    w.passId,
    ACCESS_GATE,
    ACCESS_GATE,
    w.templateId,
    'check_in',
    'in',
    1,
    w.at,
    w.at,
    w.scanId,
  ];
  const copy = { prev_state: 'state', prev_last_at: 'last_at', prev_scan_id: 'last_scan_id' };
  const free = w.override === true;
  const wait = free ? null : w.waitMs;
  const fresh =
    w.gapMs === 0
      ? {}
      : { last_at: wait !== null && wait > w.gapMs ? lte(w.at - wait) : lt(w.at - w.gapMs) };
  const visit = g.upsert('scan_gates', COLUMNS, values, {
    when,
    returning: ['last_scan_id'],
    copy,
    update: ['state', 'last_at', 'last_scan_id'],
    inc: ['count'],
    where: {
      ...fresh,
      ...(!free && w.limit !== null ? { count: lt(w.limit) } : {}),
      last_scan_id: ne(w.scanId),
    },
  });
  // Inside the gap: the same visit, so no count and no limit; the wait still holds.
  const sameVisit =
    w.gapMs === 0 || (wait !== null && wait > w.gapMs)
      ? null
      : g.upsert('scan_gates', COLUMNS, values, {
          when: [
            ...when,
            ...(wait === null ? [] : [exists('scan_gates', { ...key, last_at: lte(w.at - wait) })]),
          ],
          returning: ['last_scan_id'],
          copy,
          update: ['state', 'last_at', 'last_scan_id'],
          where: { last_at: gte(w.at - w.gapMs), last_scan_id: ne(w.scanId) },
        });
  return { visit, sameVisit };
}

/** This scan took the gate and it started a visit: the row's previous touch was a gap or more ago. */
export const startedVisit = (w: Pick<AccessGateWrite, 'passId' | 'scanId' | 'at' | 'gapMs'>) =>
  exists('scan_gates', {
    pass_id: w.passId,
    action_id: ACCESS_GATE,
    scope: ACCESS_GATE,
    last_scan_id: w.scanId,
    ...(w.gapMs === 0 ? {} : { prev_last_at: orNull(lt(w.at - w.gapMs)) }),
  });

/** The pass's org and mode, before any authority exists for it. */
export const passTarget = (db: D1Database, passId: string) =>
  first<{ orgId: string; mode: Mode }>(
    db,
    'SELECT org_id AS orgId, mode FROM passes WHERE id = ?',
    [passId],
  );

/** The org's own templates whose active version is an Access card. */
export const accessTemplates = (db: D1Database, orgId: string) =>
  all<AccessTemplateRow>(
    db,
    `SELECT t.id AS id, t.name AS name, tv.manifest AS manifest FROM templates t
     JOIN template_versions tv ON tv.template_id = t.id AND tv.version = t.active_version
     WHERE t.org_id = ? AND t.status = 'active' AND json_type(tv.manifest, '$.scan.access') = 'object'
     ORDER BY t.name, t.id LIMIT 200`,
    [orgId],
  );
