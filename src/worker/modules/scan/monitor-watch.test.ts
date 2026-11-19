import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { accessTemplate, makeDoor } from './access-test-fixtures.ts';
import { kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import {
  DISPLAY_TPL,
  personInside,
  trackedZone as plainZone,
  useKit,
} from './occupancy/whos-in-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { overrideAs, signIn } from './overrides-test-fixtures.ts';
import { key } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
});

interface Watch {
  scannerIds?: string[];
  sessionIds?: string[];
  zoneIds?: string[];
  eventId?: string;
}

/** A monitor with a watch and no scanning session, a desk staff member signed in. */
async function standalone(watch: Watch, o: { orgId?: string; mode?: 'live' | 'test' } = {}) {
  const monitor = await kit.scanner({
    deviceRole: 'monitor',
    ...(o.orgId ? { orgId: o.orgId } : {}),
    ...(o.mode ? { mode: o.mode } : {}),
    settings: { deskActions: true, staffSignIn: true, roleWithoutSignIn: 'desk' },
  });
  await run(
    kit.env.DB,
    `INSERT INTO scanner_setups (scanner_id, org_id, mode, watch)
     SELECT id, org_id, mode, ? FROM scanners WHERE id = ?`,
    [JSON.stringify({ scannerIds: [], allOrg: false, ...watch }), monitor.id],
  );
  const staff = await kit.staff('desk');
  await signIn(monitor.id, staff.id);
  return monitor;
}

const inside = async (h: Record<string, string>) => {
  const res = await kit.get(h, '/live/inside');
  return (await res.json()) as { items: { holder: string | null }[]; places: { place: string }[] };
};
const markOut = (h: Record<string, string>, passId: string, place: string) =>
  kit.post(h, '/mark-out', { idempotencyKey: key(), passId, place });

async function eventRow(o: { orgId?: string } = {}) {
  const id = kit.fx.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO scan_events (id, org_id, mode, name, opens_at, closes_at, time_zone, reentry, created_at, updated_at)
     VALUES (?, ?, 'live', 'Gala', ?, ?, 'UTC', 1, ?, ?)`,
    [id, o.orgId ?? kit.org.id, now - 1000, now + 3_600_000, now, now],
  );
  return id;
}

describe("standalone monitor: Who's in and Mark as out are watch-scoped", () => {
  it('lists a watched zone and its children, nothing outside the watch', async () => {
    const tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
    const parent = await plainZone();
    const child = await plainZone({ parentId: parent.id });
    const other = await plainZone();
    await personInside(tpl, 'In Child', [`zone:${child.id}`]);
    await personInside(tpl, 'Elsewhere', [`zone:${other.id}`]);
    const body = await inside((await standalone({ zoneIds: [parent.id] })).headers);
    expect(body.items.map((i) => i.holder)).toEqual(['In Child']);
    expect(JSON.stringify(body)).not.toContain('Elsewhere');
  });

  it('lists a watched event and a watched session, and is empty for an unwatched place', async () => {
    const tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
    const ev = await eventRow();
    const z = await plainZone();
    const sessionZone = await plainZone();
    await personInside(tpl, 'At Gala', [`event:${ev}`]);
    await personInside(tpl, 'Session Zone', [`zone:${sessionZone.id}`]);
    await personInside(tpl, 'Unwatched', [`zone:${z.id}`]);
    const door = await makeDoor([tpl], [sessionZone.id]);
    expect(
      (await inside((await standalone({ eventId: ev })).headers)).items.map((i) => i.holder),
    ).toEqual(['At Gala']);
    const viaSession = await inside((await standalone({ sessionIds: [door.sessionId] })).headers);
    expect(viaSession.items.map((i) => i.holder)).toEqual(['Session Zone']);
    const viaScanner = await inside((await standalone({ scannerIds: [door.scanner.id] })).headers);
    expect(viaScanner.items.map((i) => i.holder)).toEqual(['Session Zone']);
    const nothing = await inside((await standalone({ zoneIds: [(await plainZone()).id] })).headers);
    expect(nothing.items).toEqual([]);
  });

  it('marks out inside the watch, refuses outside it, across orgs and across modes', async () => {
    const tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
    const z = await plainZone();
    const outside = await plainZone();
    const p = await personInside(tpl, 'Stuck', [`zone:${z.id}`, `zone:${outside.id}`]);
    const m = await standalone({ zoneIds: [z.id] });
    expect((await markOut(m.headers, p.id, `zone:${outside.id}`)).status).toBe(422);
    expect((await markOut(m.headers, p.id, `zone:${z.id}`)).status).toBe(200);

    // A foreign org's monitor that names this org's zone reaches nothing of it.
    const foreign = await makeOrg(kit.fx);
    const m2 = await standalone({ zoneIds: [outside.id] }, { orgId: foreign.id });
    expect((await markOut(m2.headers, p.id, `zone:${outside.id}`)).status).not.toBe(200);
    expect((await kit.get(m2.headers, '/live/inside')).status).not.toBe(200);

    const tp = await personInside(tpl, 'Test Mode', [`zone:${z.id}`], { mode: 'test' });
    expect((await markOut(m.headers, tp.id, `zone:${z.id}`)).status).toBe(422);
  });
});

describe('standalone monitor: Let in is watch-scoped', () => {
  async function held() {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const door = await makeDoor([tpl], [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(door, pass);
    kit.clock.advance(5 * MINUTE);
    const hold = await scanAt(door, pass);
    expect(hold).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
    return { tpl, gym, door, hold: hold.scanId as string };
  }

  it('lets in a refusal of a watched station, zone, session or event; refuses unwatched ones', async () => {
    const r = await held();
    const [row] = await all<{ zone_id: string | null }>(
      kit.env.DB,
      'SELECT zone_id FROM scans WHERE id = ?',
      [r.hold],
    );
    const ev = await eventRow();
    const unwatched = await standalone({ scannerIds: [(await kit.scanner({})).id] });
    const refused = await overrideAs(unwatched.headers, r.hold);
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('SCAN_OVERRIDE_INVALID');
    expect((await overrideAs((await standalone({ eventId: ev })).headers, r.hold)).status).toBe(
      422,
    );
    if (row?.zone_id)
      expect(
        (
          await overrideAs(
            (
              await standalone({ zoneIds: [(await plainZone()).id] })
            ).headers,
            r.hold,
          )
        ).status,
      ).toBe(422);
    const watcher = await standalone({ sessionIds: [r.door.sessionId] });
    expect((await overrideAs(watcher.headers, r.hold)).status).toBe(200);
  });

  it('lets in via a watched station', async () => {
    const r = await held();
    const m = await standalone({ scannerIds: [r.door.scanner.id] });
    expect((await overrideAs(m.headers, r.hold)).status).toBe(200);
  });

  it('refuses across orgs and modes', async () => {
    const r = await held();
    const foreign = await makeOrg(kit.fx);
    const fm = await standalone({ scannerIds: [r.door.scanner.id] }, { orgId: foreign.id });
    expect((await overrideAs(fm.headers, r.hold)).status).not.toBe(200);
    const tm = await standalone({ scannerIds: [r.door.scanner.id] }, { mode: 'test' });
    expect((await overrideAs(tm.headers, r.hold)).status).toBe(422);
  });
});
