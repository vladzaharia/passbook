import type { ZoneNode } from '../../../passkit/template/access/index.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { type Check, exactlyOne, rowIs } from '../../platform/authority-checks.ts';
import { exists, type GrantCond, notExists, tenantCheck } from '../../platform/authority-cond.ts';
import { gt, gte, lt, lte, ne, orNull } from '../../platform/authority-expr.ts';
import { all, first, stmt } from '../../platform/db.ts';
import type { OccZone } from './occupancy/rules.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { readScanEffectStmt } from './repo-scan-effect-snapshots.ts';
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
  sort: number;
  occupancy: OccZone['occupancy'];
  capacity: number | null;
  max_stay_minutes: number | null;
  clear_at: string | null;
  hard_limit: number;
  archived_at: number | null;
  updated_at: number;
}

/** The org's zones, archived ones included, for the evaluator and occupancy. Read with the preflight. */
export const orgZonesStmt = (db: D1Database, orgId: string): D1PreparedStatement =>
  stmt(
    db,
    `SELECT id, key, name, parent_id, time_zone, sort, occupancy, capacity, max_stay_minutes, clear_at, hard_limit,
       archived_at, updated_at FROM scan_zones
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

export const occZonesOf = (result: D1Result | undefined): OccZone[] =>
  ((result?.results ?? []) as unknown as ZoneRaw[]).map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    sort: r.sort,
    timeZone: r.time_zone,
    occupancy: r.occupancy,
    capacity: r.capacity,
    maxStayMinutes: r.max_stay_minutes,
    clearAt: r.clear_at,
    hardLimit: r.hard_limit === 1,
    archivedAt: r.archived_at,
    updatedAt: r.updated_at,
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

/** The gate row as the effect snapshot reads it (read with the zones), and the visit's start. */
export const accessGateReads = (db: D1Database, passId: string): D1PreparedStatement[] => [
  readScanEffectStmt(db, { passId, actionId: ACCESS_GATE, scope: ACCESS_GATE }, ACCESS_GATE),
  stmt(db, 'SELECT visit_at FROM scan_gates WHERE pass_id = ? AND action_id = ? AND scope = ?', [
    passId,
    ACCESS_GATE,
    ACCESS_GATE,
  ]),
];

export const visitAtOf = (result: D1Result | undefined): number | null =>
  ((result?.results?.[0] as { visit_at: number | null } | undefined)?.visit_at ?? null) as
    | number
    | null;

export interface ZoneLink {
  id: string;
  parentId: string | null;
  key: string;
}

/**
 * The deciding zone and every zone above it are what the decision read (id, parent, key, live), and
 * the zone is still one of the session's, at commit (C6). A grant by an ancestor's key follows the chain.
 */
export function accessZoneChecks(chain: readonly ZoneLink[], sessionId: string | null): Check[] {
  const [zone] = chain;
  if (!zone) return [];
  return [
    tenantCheck(
      'config',
      `NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM scan_zones z
        WHERE z.id = json_extract(j.value, '$.id') AND z.parent_id IS json_extract(j.value, '$.p')
          AND z.key = json_extract(j.value, '$.k') AND z.archived_at IS NULL AND z.org_id = {org}))`,
      [JSON.stringify(chain.map((n) => ({ id: n.id, p: n.parentId, k: n.key })))],
    ),
    ...(sessionId === null
      ? []
      : [
          exactlyOne(
            'scanning_session_zones',
            { session_id: sessionId, zone_id: zone.id },
            'session_id',
            'config',
          ),
        ]),
  ];
}

/**
 * The pass is still the version the decision read, at commit: a suspend, a plan change or a new end
 * between the read and the write refuses this scan (`SCAN_PASS_CHANGED`, the client rescans). A
 * publish that changes anything refuses one scan too; that is the price of not comparing inputs
 * in SQL, and only Access cards pay it.
 */
export const accessInputPin = (passId: string, version: number): Check =>
  rowIs('passes', passId, { version }, 'lineage');

export interface AccessGateWrite {
  passId: string;
  templateId: string;
  scanId: string;
  at: number;
  /** A visit lasts this long from its start; 0: every grant is a visit. */
  gapMs: number;
  /** A grant within this long of the last is held; null: off. */
  waitMs: number | null;
  /** The guest's visit limit; null: none. */
  limit: number | null;
  /** A Manager let a `cooldown` through: the wait is waived. */
  waiveWait?: boolean;
  /** A Manager let a `guest_visits_used` through: the limit is waived. */
  waiveLimit?: boolean;
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
  'visit_at',
];

/**
 * The visit gate in the grant (AX 3.5). A new visit (the last began over a gap ago) counts and meets
 * the limit and the wait; a grant inside the visit leaves the count alone, so racing scans of a guest
 * with one visit left both pass and the count rises once. Exactly one statement writes the row
 * (`last_scan_id`), the first grant ever inserts it, and the row's time never moves back.
 */
export function writeAccessGate(
  g: Grant,
  w: AccessGateWrite,
  when: GrantCond[],
): { visit: GrantedStatement; sameVisit: GrantedStatement | null } {
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
    w.at,
  ];
  const wait = w.waiveWait ? null : w.waitMs;
  // The time the row may be written at: not before its last grant (`last_at` never moves back), and
  // after the wait when there is one.
  const quiet = { last_at: lte(wait === null ? w.at : w.at - wait) };
  const copy = {
    prev_state: 'state',
    prev_last_at: 'last_at',
    prev_scan_id: 'last_scan_id',
    prev_visit_at: 'visit_at',
  };
  const visit = g.upsert('scan_gates', COLUMNS, values, {
    tag: RACE_GATE_WRITE,
    when,
    returning: ['last_scan_id'],
    copy,
    update: ['state', 'last_at', 'last_scan_id', 'visit_at'],
    inc: ['count'],
    where: {
      ...(w.gapMs === 0 ? {} : { visit_at: lt(w.at - w.gapMs) }),
      ...quiet,
      ...(!w.waiveLimit && w.limit !== null ? { count: lt(w.limit) } : {}),
      last_scan_id: ne(w.scanId),
    },
  });
  const sameVisit =
    w.gapMs === 0
      ? null
      : g.upsert('scan_gates', COLUMNS, values, {
          tag: RACE_GATE_WRITE,
          when,
          returning: ['last_scan_id'],
          copy,
          update: ['state', 'last_at', 'last_scan_id'],
          where: { visit_at: gte(w.at - w.gapMs), ...quiet, last_scan_id: ne(w.scanId) },
        });
  return { visit, sameVisit };
}

/** This scan took the gate and it started a visit: the visit it replaced began a gap or more ago. */
export const startedVisit = (w: Pick<AccessGateWrite, 'passId' | 'scanId' | 'at' | 'gapMs'>) =>
  exists('scan_gates', {
    pass_id: w.passId,
    action_id: ACCESS_GATE,
    scope: ACCESS_GATE,
    last_scan_id: w.scanId,
    ...(w.gapMs === 0 ? {} : { prev_visit_at: orNull(lt(w.at - w.gapMs)) }),
  });

const visitGate = (passId: string) => ({
  pass_id: passId,
  action_id: ACCESS_GATE,
  scope: ACCESS_GATE,
});

/**
 * The visit gate's wait, as a condition another statement can carry (an occupancy entry runs before
 * the gate and must not move unless the gate will): past the wait, and the row's time never moves back.
 */
export const accessQuiet = (passId: string, at: number, waitMs: number | null): GrantCond =>
  notExists('scan_gates', {
    ...visitGate(passId),
    last_at: gt(waitMs === null ? at : at - waitMs),
  });

/** The visit gate's limit, likewise: another visit is allowed, or this grant is inside the current one. */
export const accessVisitOpen = (
  passId: string,
  at: number,
  gapMs: number,
  limit: number,
): GrantCond =>
  notExists('scan_gates', {
    ...visitGate(passId),
    count: gte(limit),
    ...(gapMs === 0 ? {} : { visit_at: lt(at - gapMs) }),
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
