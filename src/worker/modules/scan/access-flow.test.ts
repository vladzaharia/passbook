import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { countD1, makeOrg, TEST_NOW } from '../../../../test/helpers/index.ts';
import type { AccessManifest } from '../../../passkit/types.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { first, run } from '../../platform/db.ts';
import {
  ACCESS,
  accessTemplate,
  gateRow,
  grantOf,
  makeDoor,
  makeZone,
  scanRows,
} from './access-test-fixtures.ts';
import { HOUR, kit, MINUTE, out, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const MORNING = ['06:00-10:00'];
const GYM: AccessManifest = {
  ...ACCESS,
  plans: [
    ...ACCESS.plans,
    {
      id: 'swim',
      label: 'Swim',
      kind: 'timed',
      hours: { mon: ['06:00-16:00'] },
      zones: [{ zone: 'studio' }, { zone: 'pool', hours: { mon: MORNING } }],
    },
  ],
};

describe('access: zones', () => {
  it('opens a door that checks several zones when any is open, and names the one that decided', async () => {
    const tpl = await accessTemplate(GYM);
    const pool = await makeZone('pool');
    const studio = await makeZone('studio');
    const both = await makeDoor([tpl], [pool, studio]);
    const poolOnly = await makeDoor([tpl], [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'swim' });
    // 12:00 on a Monday: the studio is open, the pool closed at 10.
    const studioGrant = await grantOf(both.headers, pass);
    expect(studioGrant).toMatchObject({ kind: 'ok', access: { zone: { id: studio } } });
    const refused = await grantOf(poolOnly.headers, pass);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'outside_hours' });
    expect(refused.access?.zone?.id).toBe(pool);
    kit.clock.set(TEST_NOW - 4 * HOUR);
    const early = await grantOf(both.headers, await kit.scanPass(tpl, { plan: 'swim' }));
    expect(early.access?.zone?.id).toBe(pool);
  });

  it('opens any zone the pass opens at a door with no zones', async () => {
    const tpl = await accessTemplate(GYM);
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'swim' });
    expect(await grantOf(d.headers, pass)).toMatchObject({ kind: 'ok', access: { zone: null } });
  });

  it('grants nothing at a door that checks an archived zone', async () => {
    const tpl = await accessTemplate();
    const gone = await makeZone('gone-room', { archived: true });
    const d = await makeDoor([tpl], [gone]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    expect(await grantOf(d.headers, pass)).toMatchObject({
      kind: 'refused',
      reason: 'zone_not_included',
    });
  });

  it('refuses a plan its template no longer has, and logs ids only', async () => {
    const tpl = await accessTemplate();
    const secret = await makeZone('sponsor-lounge');
    const d = await makeDoor([tpl], [secret]);
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((line: unknown) => {
        lines.push(String(line));
      }),
    );
    try {
      const ghost = await kit.scanPass(tpl, { plan: 'gold', sponsor: 'Maya Okafor' });
      // The plan left the template after the pass was issued.
      await run(
        kit.env.DB,
        "UPDATE passes SET personalization = json_set(personalization, '$.plan', 'retired') WHERE id = ?",
        [ghost.id],
      );
      expect((await grantOf(d.headers, ghost)).reason).toBe('zone_not_included');
      const gold = await kit.scanPass(tpl, { plan: 'gold', sponsor: 'Maya Okafor' });
      expect((await grantOf(d.headers, gold)).kind).toBe('ok');
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const text = lines.join('\n');
    expect(text).toContain('ACCESS_PLAN_UNKNOWN');
    for (const secretText of [
      'Zone sponsor-lounge',
      'sponsor-lounge',
      'Maya Okafor',
      'Off-peak',
      'retired',
    ])
      expect(text).not.toContain(secretText);
  });
});

describe('access: the visit gate under concurrency', () => {
  it('lets two scanners through a guest with one visit left; the count rises once', async () => {
    const tpl = await accessTemplate();
    const a = await makeDoor([tpl]);
    const b = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 2 });
    expect((await grantOf(a.headers, pass)).kind).toBe('ok');
    kit.clock.advance(3 * HOUR);
    // B commits between A's read and A's write.
    const seen: { second?: ScanOutcome } = {};
    const { result: first, fired } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      async () => {
        seen.second = await grantOf(b.headers, pass);
      },
      () => grantOf(a.headers, pass),
    );
    expect(fired).toBe(true);
    expect([first.kind, seen.second?.kind]).toEqual(['ok', 'ok']);
    expect(await gateRow(pass.id)).toMatchObject({ count: 2 });
    const rows = await scanRows(pass.id);
    expect(rows.map((r) => r.visit)).toEqual([1, 0, 1]);
    expect(rows.filter((r) => r.visit === 1)).toHaveLength(2);
    expect(first.access?.visit).toBe(false);
    expect(seen.second).toMatchObject({ access: { visit: true, visits: { used: 2, limit: 2 } } });
  });

  it('inserts the gate once when two scanners meet a pass for the first time', async () => {
    const tpl = await accessTemplate();
    const a = await makeDoor([tpl]);
    const b = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const seen: { second?: ScanOutcome } = {};
    const { result: first } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      async () => {
        seen.second = await grantOf(b.headers, pass);
      },
      () => grantOf(a.headers, pass),
    );
    expect([first.kind, seen.second?.kind]).toEqual(['ok', 'ok']);
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
    expect((await scanRows(pass.id)).filter((r) => r.visit === 1)).toHaveLength(1);
  });

  it('refuses a guest with none left at both doors', async () => {
    const tpl = await accessTemplate();
    const a = await makeDoor([tpl]);
    const b = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'guest', visits: 1 });
    expect((await grantOf(a.headers, pass)).kind).toBe('ok');
    kit.clock.advance(3 * HOUR);
    const both = await Promise.all([grantOf(a.headers, pass), grantOf(b.headers, pass)]);
    expect(both.map((o) => o.reason)).toEqual(['guest_visits_used', 'guest_visits_used']);
    expect(await gateRow(pass.id)).toMatchObject({ count: 1 });
  });
});

describe('access: undo', () => {
  const undo = async (headers: Record<string, string>, scanId: string | null) =>
    kit.post(headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });

  it('undoes the first grant by deleting the gate, and a visit by taking one back', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const first = await grantOf(d.headers, pass);
    const res = await undo(d.headers, first.scanId);
    expect(res.status).toBe(200);
    expect(await gateRow(pass.id)).toBeNull();

    const one = await grantOf(d.headers, pass);
    kit.clock.advance(3 * HOUR);
    const two = await grantOf(d.headers, pass);
    expect(two.access?.visits?.used).toBe(2);
    expect((await undo(d.headers, two.scanId)).status).toBe(200);
    expect(await gateRow(pass.id)).toMatchObject({
      count: 1,
      last_at: TEST_NOW,
      prev_last_at: null,
    });
    // Only the grant the gate points at can be undone.
    expect((await undo(d.headers, one.scanId)).status).toBe(409);
  });

  it('undoes a grant inside a visit without taking a visit back', async () => {
    const tpl = await accessTemplate();
    const d = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await grantOf(d.headers, pass);
    kit.clock.advance(30 * MINUTE);
    const inside = await grantOf(d.headers, pass);
    expect(inside.access?.visit).toBe(false);
    expect((await undo(d.headers, inside.scanId)).status).toBe(200);
    expect(await gateRow(pass.id)).toMatchObject({ count: 1, last_at: TEST_NOW });
    const next = await grantOf(d.headers, pass);
    expect(next.access).toMatchObject({ visit: false, visits: { used: 1 } });
  });
});

describe('access: events, tenants and ready', () => {
  it('checks an access card in once at an event, without zones or hours', async () => {
    const tpl = await accessTemplate();
    const event = await kit.event({ templateIds: [tpl], closesAt: TEST_NOW + 24 * HOUR });
    const s = await kit.scanner({ eventId: event.id });
    kit.clock.set(TEST_NOW + 8 * HOUR);
    const pass = await kit.scanPass(tpl, { plan: 'off_peak' });
    const first = await grantOf(s.headers, pass);
    expect(first).toMatchObject({ kind: 'ok', access: null });
    expect(await gateRow(pass.id)).toBeNull();
    expect(await grantOf(s.headers, pass)).toMatchObject({
      kind: 'heads_up',
      reason: 'already_done',
    });
    const held = await kit.scanPass(tpl, { plan: 'gold', status: 'Suspended' });
    expect(await grantOf(s.headers, held)).toMatchObject({ kind: 'refused', reason: 'suspended' });
  });

  it('never opens a door for another org, and a foreign zone grants nothing', async () => {
    const tpl = await accessTemplate();
    const foreign = await makeOrg(kit.fx);
    const otherTpl = await kit.scanTemplate(
      'Other access',
      { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }], access: ACCESS },
      { orgId: foreign.id },
    );
    const theirPass = await kit.scanPass(otherTpl, { plan: 'gold' }, { orgId: foreign.id });
    const theirZone = await makeZone('vault', { orgId: foreign.id });
    const d = await makeDoor([tpl], [theirZone]);
    const unknown = await grantOf(d.headers, theirPass);
    expect(unknown).toMatchObject({
      kind: 'refused',
      reason: 'not_found',
      access: null,
      card: null,
    });
    const mine = await kit.scanPass(tpl, { plan: 'gold' });
    const refused = await grantOf(d.headers, mine);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'zone_not_included' });
    expect(JSON.stringify(refused)).not.toContain('vault');
    expect(refused.access?.zone).toBeNull();
    expect(await gateRow(theirPass.id)).toBeNull();
  });

  it('shows access on ready and writes nothing', async () => {
    const tpl = await accessTemplate();
    const pool = await makeZone('lap-pool');
    const d = await makeDoor([tpl], [pool]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const res = await kit.post(d.headers, '/resolve', {
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
    });
    const ready = await out(res);
    expect(ready).toMatchObject({
      kind: 'ready',
      card: { access: { plan: { id: 'gold' }, zone: { id: pool } } },
    });
    expect(await gateRow(pass.id)).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT count(*) AS n FROM scans WHERE pass_id=?', [pass.id]),
    ).toEqual({ n: 0 });
  });
});

describe('access: round trips', () => {
  it('a door check-in stays within 6 trips after the guard, winner and loser', async () => {
    const tpl = await accessTemplate();
    const zone = await makeZone('trips-room');
    const d = await makeDoor([tpl], [zone]);
    const trips = async (run: () => Promise<unknown>) => {
      const counted = countD1(kit.env.DB);
      const original = kit.env.DB;
      Object.assign(kit.env, { DB: counted.db });
      try {
        await run();
      } finally {
        Object.assign(kit.env, { DB: original });
      }
      return counted.count();
    };
    await grantOf(d.headers, await kit.scanPass(tpl, { plan: 'gold' }));
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const base = await trips(() => kit.post(d.headers, '/actions', {}));
    const winner = (await trips(() => grantOf(d.headers, pass))) - base;
    const again = (await trips(() => grantOf(d.headers, pass))) - base;
    expect(winner).toBeLessThanOrEqual(5);
    expect(again).toBeLessThanOrEqual(5);
  });
});
