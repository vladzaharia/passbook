import { beforeAll, describe, expect, it } from 'vitest';
import { makePass } from '../../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../../shared/contracts/scan-access.ts';
import { CRON_QUERY_BUDGET, countQueries } from '../../../jobs/query-counter.ts';
import { all, first, run } from '../../../platform/db.ts';
import { createJobContext } from '../../../platform/service-context.ts';
import { toFeed } from '../feed-projection.ts';
import type { HistoryRow } from '../history-row.ts';
import { scanningSessionsFixture } from '../scanning-sessions-test-fixtures.ts';
import { exitGrant } from './auto-exit.ts';
import { autoTapOut, DUE_BATCH, verdict } from './jobs.ts';
import type { DueRow } from './repo-reads.ts';
import { exitAsGiven, type OccZone } from './rules.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

const HOUR = 3_600_000;
let seq = 0;
async function zone(extra: Record<string, unknown> = {}): Promise<ScanZone> {
  const key = `auto${(seq++).toString(36)}`;
  const res = await fixture.call('POST', '/scan-zones', {
    orgId: fixture.kit.org.id,
    key,
    name: `Auto ${key}`,
    occupancy: 'track',
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
}

const ctx = () => createJobContext(fixture.kit.env, 'test', { clock: fixture.kit.clock });
const newPass = async () =>
  (await makePass(fixture.kit.fx, { orgId: fixture.kit.org.id, template: fixture.kit.template }))
    .id;

/** An in row as an entry would write it. */
async function inside(passId: string, z: ScanZone, enteredAt: number, due: number | null) {
  const scanId = `seed-${seq++}`;
  await run(
    fixture.kit.env.DB,
    `INSERT INTO scan_presence (pass_id, org_id, scope, state, tracking, entered_at, first_at, last_entry_at,
       last_scan_id, due_at) VALUES (?, ?, ?, 'in', 1, ?, ?, ?, ?, ?)`,
    [passId, fixture.kit.org.id, `zone:${z.id}`, enteredAt, enteredAt, enteredAt, scanId, due],
  );
  return scanId;
}

const rowOf = (passId: string, z: ScanZone) =>
  first<{ state: string; due_at: number | null; last_scan_id: string }>(
    fixture.kit.env.DB,
    'SELECT state, due_at, last_scan_id FROM scan_presence WHERE pass_id = ? AND scope = ?',
    [passId, `zone:${z.id}`],
  );
const autoScans = (passId?: string) =>
  all<{ id: string; out_cause: string; method: string; direction: string; state: string }>(
    fixture.kit.env.DB,
    `SELECT id, out_cause, method, direction, state FROM scans WHERE actor_key = 'sys:occupancy'
     ${passId ? 'AND pass_id = ?' : ''}`,
    passId ? [passId] : [],
  );
const dueRow = async (passId: string, z: ScanZone): Promise<DueRow> => {
  const r = await first<DueRow>(
    fixture.kit.env.DB,
    `SELECT x.pass_id, x.org_id, x.mode, x.scope, x.entered_at, x.last_entry_at, x.last_scan_id, x.due_at, p.template_id
     FROM scan_presence x JOIN passes p ON p.id = x.pass_id WHERE x.pass_id = ? AND x.scope = ?`,
    [passId, `zone:${z.id}`],
  );
  if (!r) throw new Error('no row');
  return r;
};

describe('auto tap-out', () => {
  it('closes a pass past Max stay with a system scan', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await newPass();
    await inside(p, z, now - 2 * HOUR, now - HOUR);
    await autoTapOut(ctx());
    expect(await rowOf(p, z)).toMatchObject({ state: 'out', due_at: null });
    expect(await autoScans(p)).toEqual([
      expect.objectContaining({
        out_cause: 'stay',
        method: 'auto',
        direction: 'out',
        state: 'done',
      }),
    ]);
    const ev = await all<{ kind: string; actor_type: string; data: string }>(
      fixture.kit.env.DB,
      'SELECT kind, actor_type, data FROM pass_events WHERE pass_id = ?',
      [p],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'scan.checked_out', actor_type: 'system' });
    expect(JSON.parse(ev[0]?.data ?? '{}')).toMatchObject({ method: 'auto', outCause: 'stay' });
    const scan = await first<{ actor_type: string; actor_id: string; outcome: string }>(
      fixture.kit.env.DB,
      "SELECT actor_type, actor_id, outcome FROM scans WHERE actor_key = 'sys:occupancy' AND pass_id = ?",
      [p],
    );
    expect(scan).toEqual({ actor_type: 'system', actor_id: 'occupancy', outcome: 'ok' });
  });

  it('names Clear at as the cause when it comes first', async () => {
    const now = fixture.kit.clock.now();
    const entered = now - 2 * HOUR;
    const clearAt = new Date(entered + HOUR).toISOString().slice(11, 16);
    const z = await zone({ timeZone: 'UTC', clearAt, maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, z, entered, entered + HOUR);
    await autoTapOut(ctx());
    expect((await autoScans(p)).map((s) => s.out_cause)).toEqual(['clear']);
  });

  it('leaves a pass that is not due and one whose zone has no clock', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, z, now - HOUR, now + 9 * HOUR);
    await autoTapOut(ctx());
    expect((await rowOf(p, z))?.state).toBe('in');
    expect(await autoScans(p)).toEqual([]);
  });

  it('re-arms a stale due time instead of tapping out early', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, z, now - 2 * HOUR, now - HOUR);
    await autoTapOut(ctx());
    expect(await rowOf(p, z)).toMatchObject({ state: 'in', due_at: now - 2 * HOUR + 600 * 60_000 });
    expect(await autoScans(p)).toEqual([]);
  });

  it('a tap since the read wins; the cron changes nothing and leaves no record', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await newPass();
    await inside(p, z, now - 2 * HOUR, now - HOUR);
    const row = await dueRow(p, z);
    await run(
      fixture.kit.env.DB,
      "UPDATE scan_presence SET last_scan_id = 'tap', last_entry_at = ? WHERE pass_id = ?",
      [now, p],
    );
    await exitGrant(ctx(), row, exitAsGiven([], row.scope), 'stay', now).commit();
    expect(await rowOf(p, z)).toMatchObject({ state: 'in', last_scan_id: 'tap' });
    expect(await autoScans(p)).toEqual([]);
    expect(
      await all(fixture.kit.env.DB, 'SELECT 1 FROM pass_events WHERE pass_id = ?', [p]),
    ).toEqual([]);
    const pending = await first(
      fixture.kit.env.DB,
      "SELECT 1 FROM scans WHERE actor_key = 'sys:occupancy' AND state = 'pending'",
    );
    expect(pending).toBeNull();
  });

  it('a retried run collapses on the idempotency key', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await newPass();
    await inside(p, z, now - 2 * HOUR, now - HOUR);
    const row = await dueRow(p, z);
    const plan = exitAsGiven([], row.scope);
    await exitGrant(ctx(), row, plan, 'stay', now).commit();
    // The exit is lost but the claim stays (a crash between them): the retry must not exit again.
    await run(
      fixture.kit.env.DB,
      "UPDATE scan_presence SET state = 'in', last_scan_id = ? WHERE pass_id = ?",
      [row.last_scan_id, p],
    );
    await exitGrant(ctx(), row, plan, 'stay', now).commit();
    expect(await autoScans(p)).toHaveLength(1);
    expect((await rowOf(p, z))?.state).toBe('in');
  });

  it('skips a suspended org and never starves the next', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 60 });
    const p = await newPass();
    await inside(p, z, now - 2 * HOUR, now - HOUR);
    const row = await dueRow(p, z);
    const org = fixture.kit.org.id;
    const db = fixture.kit.env.DB;
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org]);
    try {
      await autoTapOut(ctx());
      expect((await rowOf(p, z))?.state).toBe('in');
      await expect(
        exitGrant(ctx(), row, exitAsGiven([], row.scope), 'stay', now).commit(),
      ).rejects.toThrow();
      expect(await autoScans(p)).toEqual([]);
    } finally {
      await run(db, "UPDATE orgs SET status = 'active' WHERE id = ?", [org]);
    }
    await autoTapOut(ctx());
    expect((await rowOf(p, z))?.state).toBe('out');
  });

  it('closes DUE_BATCH rows a run and stays under the query budget', async () => {
    const { kit } = fixture;
    const now = kit.clock.now();
    const p = await newPass();
    await run(kit.env.DB, 'DELETE FROM scan_presence');
    const total = DUE_BATCH + 5;
    for (let at = 0; at < total; at += 20) {
      const zs = await Promise.all(
        Array.from({ length: Math.min(20, total - at) }, () => zone({ maxStayMinutes: 60 })),
      );
      for (const z of zs) await inside(p, z, now - 2 * HOUR, now - HOUR);
    }
    const counter = countQueries(kit.env);
    await autoTapOut(createJobContext(counter.env, 'test', { clock: kit.clock }));
    expect(counter.count()).toBeLessThan(CRON_QUERY_BUDGET);
    const open = (s: string) =>
      first<{ n: number }>(
        kit.env.DB,
        `SELECT count(*) AS n FROM scan_presence WHERE state = '${s}'`,
      );
    expect((await open('out'))?.n).toBe(DUE_BATCH);
    expect((await open('in'))?.n).toBe(5);
    await autoTapOut(ctx());
    expect((await open('in'))?.n).toBe(0);
  }, 120_000);
});

describe('a zone that stopped tracking', () => {
  it('Track off closes its rows with cause zone, and so does archive', async () => {
    const { kit } = fixture;
    const now = kit.clock.now();
    const off = await zone({ maxStayMinutes: 600 });
    const arch = await zone({ maxStayMinutes: 600 });
    const [a, b] = [await newPass(), await newPass()];
    await inside(a, off, now - HOUR, now + 9 * HOUR);
    await inside(b, arch, now - HOUR, now + 9 * HOUR);
    expect(
      (
        await fixture.call('PATCH', `/scan-zones/${off.id}`, {
          occupancy: 'off',
          maxStayMinutes: null,
        })
      ).status,
    ).toBe(200);
    expect((await fixture.call('PATCH', `/scan-zones/${arch.id}`, { archived: true })).status).toBe(
      200,
    );
    await autoTapOut(ctx());
    expect((await rowOf(a, off))?.state).toBe('out');
    expect((await rowOf(b, arch))?.state).toBe('out');
    expect((await autoScans(a)).map((s) => s.out_cause)).toEqual(['zone']);
    expect((await autoScans(b)).map((s) => s.out_cause)).toEqual(['zone']);
  });

  it('a moved zone and the one below it fall due, still tracked', async () => {
    const { kit } = fixture;
    const now = kit.clock.now();
    const top = await zone({ timeZone: 'UTC', maxStayMinutes: 600 });
    const other = await zone({ timeZone: 'UTC', maxStayMinutes: 600 });
    const pool = await zone({ parentId: top.id, maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, top, now - HOUR, now + 9 * HOUR);
    await inside(p, pool, now - HOUR, now + 9 * HOUR);
    expect(
      (await fixture.call('PATCH', `/scan-zones/${pool.id}`, { parentId: other.id })).status,
    ).toBe(200);
    await autoTapOut(ctx());
    expect((await rowOf(p, pool))?.state).toBe('out');
    expect((await rowOf(p, top))?.state).toBe('in');
    expect((await autoScans(p)).map((s) => s.out_cause)).toEqual(['zone']);
  });
});

describe('a zone save recomputes the due time inside', () => {
  it('a shorter Max stay brings it forward, and Max stay off clears it', async () => {
    const { kit } = fixture;
    const now = kit.clock.now();
    const z = await zone({ maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, z, now - HOUR, now + 9 * HOUR);
    await fixture.call('PATCH', `/scan-zones/${z.id}`, { maxStayMinutes: 90 });
    expect((await rowOf(p, z))?.due_at).toBe(now - HOUR + 90 * 60_000);
    await fixture.call('PATCH', `/scan-zones/${z.id}`, { maxStayMinutes: null });
    expect((await rowOf(p, z))?.due_at).toBeNull();
  });

  it('a name change touches nothing', async () => {
    const now = fixture.kit.clock.now();
    const z = await zone({ maxStayMinutes: 600 });
    const p = await newPass();
    await inside(p, z, now - HOUR, now + 1);
    await fixture.call('PATCH', `/scan-zones/${z.id}`, { name: 'Renamed' });
    expect((await rowOf(p, z))?.due_at).toBe(now + 1);
  });
});

describe('Clear at across clock changes', () => {
  const zoneOf = (clearAt: string, timeZone: string): OccZone => ({
    id: 'z',
    parentId: null,
    name: 'Z',
    sort: 0,
    timeZone,
    occupancy: 'track',
    capacity: null,
    maxStayMinutes: null,
    clearAt,
    archivedAt: null,
    updatedAt: 1,
  });
  const row = (entered: number, due: number): DueRow => ({
    pass_id: 'p',
    org_id: 'o',
    mode: 'live',
    scope: 'zone:z',
    entered_at: entered,
    last_entry_at: entered,
    last_scan_id: 's',
    due_at: due,
    template_id: 't',
  });

  it('a clear inside the spring gap fires when the gap ends', () => {
    // 2026-03-08 in New York: 02:30 does not exist; the gap ends 03:00 EDT = 07:00Z.
    const entered = Date.UTC(2026, 2, 8, 5, 0);
    const gapEnd = Date.UTC(2026, 2, 8, 7, 0);
    const z = zoneOf('02:30', 'America/New_York');
    expect(verdict([z], row(entered, gapEnd), gapEnd - 1)).toEqual({ rearm: gapEnd });
    expect(verdict([z], row(entered, gapEnd), gapEnd)).toEqual({ exit: 'clear' });
  });

  it('the repeated autumn hour fires at its first instance', () => {
    // 2026-11-01: 01:30 happens twice; the first is 01:30 EDT = 05:30Z.
    const entered = Date.UTC(2026, 10, 1, 4, 30);
    const first = Date.UTC(2026, 10, 1, 5, 30);
    const z = zoneOf('01:30', 'America/New_York');
    expect(verdict([z], row(entered, first), first)).toEqual({ exit: 'clear' });
    expect(verdict([z], row(entered, first), first - 1)).toEqual({ rearm: first });
  });
});

describe('the feed', () => {
  it('shows Auto for a system tap-out, not manual', () => {
    const row = {
      id: 's',
      at: 1,
      method: 'auto',
      policyAvailable: false,
      passId: null,
      outcome: 'ok',
      reason: null,
      undoneAt: null,
      scannerId: null,
      eventId: null,
      passlessProofCandidate: false,
    } as unknown as HistoryRow;
    expect(toFeed(row, null).method).toBe('auto');
  });
});
