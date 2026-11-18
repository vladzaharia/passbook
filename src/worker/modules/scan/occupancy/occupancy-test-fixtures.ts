import { makePass } from '../../../../../test/helpers/index.ts';
import { grant } from '../../../platform/authority.ts';
import { setupGrant } from '../../../platform/authority-test-fixtures.ts';
import { all, first, run } from '../../../platform/db.ts';
import { entryPlan, exitAsGiven, exitPlan, type Waivers, zonePlace } from './rules.ts';
import {
  addEntry,
  addExit,
  addUndo,
  lossReads,
  lostEntry,
  occupancyZones,
  readGroupRows,
} from './service.ts';

type Zone = {
  parent?: string;
  occupancy?: 'off' | 'track' | 'enforce';
  capacity?: number;
  max_stay_minutes?: number;
  clear_at?: string;
  time_zone?: string;
};

export type Result = { ok: true; scanId: string } | { ok: false; scanId: string; reason: string };

/** One org, a membership principal on the scan grant, zones and passes, and the occupancy service on real D1. */
export async function occupancyKit(label: string) {
  const { s, route, member } = await setupGrant(`occ-${label}`);
  const db = s.f.env.DB;
  const orgId = s.org.id;
  const clock = s.f.clock;
  const zoneIds = new Map<string, string>();

  const zone = async (key: string, z: Zone = {}) => {
    const id = s.f.ids.id();
    zoneIds.set(key, id);
    const occupancy = z.occupancy ?? 'track';
    await run(
      db,
      `INSERT INTO scan_zones (id, org_id, key, name, parent_id, time_zone, occupancy, capacity, max_stay_minutes,
         clear_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [
        id,
        orgId,
        `${key}-${label}`.toLowerCase(),
        key,
        z.parent ? (zoneIds.get(z.parent) ?? null) : null,
        z.time_zone ?? null,
        occupancy,
        z.capacity ?? null,
        z.max_stay_minutes ?? null,
        z.clear_at ?? null,
      ],
    );
    return id;
  };
  const idOf = (key: string) => {
    const id = zoneIds.get(key);
    if (!id) throw new Error(`no zone ${key}`);
    return id;
  };
  const place = (key: string) => zonePlace(idOf(key));
  const pass = async (mode: 'live' | 'test' = 'live') =>
    (await makePass(s.f, { orgId, template: s.template.resolved, mode, persist: false })).id;
  const passes = async (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await pass());
    return out;
  };
  /** A finished scans row: the undo guard orders scans by time. */
  const scanRow = async (at = clock.now(), mode: 'live' | 'test' = 'live', id = s.f.ids.id()) => {
    await run(
      db,
      `INSERT INTO scans (id, org_id, mode, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, state, at)
       VALUES (?, ?, ?, 'scanner', 'occ', 'occ', ?, 'h', 'camera', 'done', ?)`,
      [id, orgId, mode, id, at],
    );
    return id;
  };
  const scanGrant = (mode: 'live' | 'test' = 'live') =>
    grant(route, {
      purpose: 'org_mode.scan.check_in',
      principal: member({ mode }),
      codes: { lineage: 'UNDO_SUPERSEDED' },
    });

  /** Plan now, commit later: two calls planned before either commits race like two doors. */
  const planEntry = async (
    passId: string,
    key: string,
    o: {
      waivers?: Waivers;
      waitMs?: number;
      mode?: 'live' | 'test';
      /** The scans row's id and claim time (default: a fresh id, now). */
      scanId?: string;
      claimedAt?: number;
    } = {},
  ) => {
    const now = clock.now();
    const mode = o.mode ?? 'live';
    const plan = entryPlan(await occupancyZones(db, orgId), idOf(key), now, 'UTC', o.waivers);
    if (!plan) throw new Error(`${key} does not track`);
    const scanId = await scanRow(o.claimedAt ?? now, mode, o.scanId);
    const g = scanGrant(mode);
    const rules = { waitMs: o.waitMs ?? null, ...(o.waivers ? { waivers: o.waivers } : {}) };
    addEntry(g, { passId, scanId, now, plan, ...rules });
    return async (): Promise<Result> => {
      const { after } = await g.commitWith(lossReads(orgId, mode, passId, plan, now));
      if (await wrote(passId, plan.place, scanId)) return { ok: true, scanId };
      const why = lostEntry(plan, after, now, rules);
      return { ok: false, scanId, reason: why?.reason ?? 'unexplained' };
    };
  };
  const planExit = async (
    passId: string,
    key: string,
    o: { lastScanId?: string; asGiven?: boolean } = {},
  ) => {
    const { lastScanId } = o;
    const now = clock.now();
    const zones = await occupancyZones(db, orgId);
    const plan = o.asGiven ? exitAsGiven(zones, place(key)) : exitPlan(zones, idOf(key));
    if (!plan) throw new Error(`${key} does not track`);
    const scanId = await scanRow(now);
    const g = scanGrant();
    addExit(g, { passId, scanId, now, plan, ...(lastScanId ? { lastScanId } : {}) });
    return async (): Promise<Result> => {
      await g.commit();
      return (await wrote(passId, plan.place, scanId))
        ? { ok: true, scanId }
        : { ok: false, scanId, reason: 'not_inside' };
    };
  };
  const enter = async (passId: string, key: string, o: Parameters<typeof planEntry>[2] = {}) =>
    (await planEntry(passId, key, o))();
  const exit = async (passId: string, key: string) => (await planExit(passId, key))();
  const fail = (e: { code?: string; message?: string }) => e.code ?? e.message ?? 'error';
  /** Read and build now, commit later: a write in between races the undo. */
  const planUndo = async (passId: string, group: string[]) => {
    try {
      const rows = await readGroupRows(db, orgId, passId, group);
      const ats = await all<{ at: number }>(
        db,
        `SELECT at FROM scans WHERE id IN (${group.map(() => '?').join(', ')})`,
        group,
      );
      const g = scanGrant();
      addUndo(g, {
        passId,
        group,
        scannedAt: Math.max(...ats.map((r) => r.at)),
        rows,
        zones: await occupancyZones(db, orgId),
        orgTimeZone: 'UTC',
      });
      return () => g.commit().then(() => 'ok', fail);
    } catch (e) {
      return async () => fail(e as { code?: string });
    }
  };
  const undo = async (passId: string, group: string[]) => (await planUndo(passId, group))();

  async function wrote(passId: string, scope: string, scanId: string) {
    return !!(await first(
      db,
      'SELECT 1 AS x FROM scan_presence WHERE pass_id = ? AND scope = ? AND last_scan_id = ?',
      [passId, scope, scanId],
    ));
  }
  const row = (passId: string, key: string) =>
    first<{
      state: string;
      entered_at: number | null;
      due_at: number | null;
      last_scan_id: string;
    }>(
      db,
      'SELECT state, entered_at, due_at, last_scan_id FROM scan_presence WHERE pass_id = ? AND scope = ?',
      [passId, place(key)],
    );
  /** Live in rows at a zone, as the statements count them. */
  const inside = async (key: string) =>
    (
      await first<{ n: number }>(
        db,
        `SELECT count(*) AS n FROM scan_presence WHERE scope = ? AND state = 'in'
           AND (due_at IS NULL OR due_at > ?)`,
        [place(key), clock.now()],
      )
    )?.n ?? 0;
  const revs = async () =>
    Object.fromEntries(
      (
        await all<{ place: string; rev: number }>(
          db,
          'SELECT place, rev FROM scan_place_revs WHERE org_id = ?',
          [orgId],
        )
      ).map((r) => [r.place, r.rev]),
    ) as Record<string, number>;

  return {
    db,
    orgId,
    clock,
    zone,
    idOf,
    place,
    pass,
    passes,
    scanRow,
    scanGrant,
    planEntry,
    planExit,
    enter,
    exit,
    planUndo,
    undo,
    row,
    inside,
    revs,
  };
}
