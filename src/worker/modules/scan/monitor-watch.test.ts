import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { accessTemplate, makeDoor } from './access-test-fixtures.ts';
import { kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import {
  DISPLAY_TPL,
  personInside,
  trackedZone as plainZone,
  useKit,
} from './occupancy/whos-in-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { overrideAs, signIn } from './overrides-test-fixtures.ts';
import { RACE_EPOCH_EVENT, RACE_SCAN_CLAIM } from './race-tags.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
});

interface Watch {
  allOrg?: boolean;
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
    expect(row?.zone_id).toBe(r.gym);
    expect(
      (await overrideAs((await standalone({ zoneIds: [(await plainZone()).id] })).headers, r.hold))
        .status,
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

describe('standalone monitor: zone and allOrg watches', () => {
  it('refuses a Let in for a scan outside the watched zones, allows one inside them', async () => {
    const tpl = await accessTemplate();
    const gym = await trackedZone({ occupancy: 'enforce' });
    const door = await makeDoor([tpl], [gym]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(door, pass);
    kit.clock.advance(5 * MINUTE);
    const hold = (await scanAt(door, pass)).scanId as string;
    const elsewhere = await standalone({ zoneIds: [(await plainZone()).id] });
    expect((await overrideAs(elsewhere.headers, hold)).status).toBe(422);
    const watcher = await standalone({ zoneIds: [gym] });
    expect((await overrideAs(watcher.headers, hold)).status).toBe(200);
  });

  it('covers every event of its own org and mode, and nothing of another org', async () => {
    const tpl = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
    const ev = await eventRow();
    const p = await personInside(tpl, 'At Gala', [`event:${ev}`]);
    const m = await standalone({ allOrg: true });
    expect((await inside(m.headers)).items.map((i) => i.holder)).toContain('At Gala');
    expect((await markOut(m.headers, p.id, `event:${ev}`)).status).toBe(200);
    const foreign = await makeOrg(kit.fx);
    const fm = await standalone({ allOrg: true }, { orgId: foreign.id });
    const p2 = await personInside(tpl, 'Second Gala', [`event:${ev}`]);
    expect((await markOut(fm.headers, p2.id, `event:${ev}`)).status).not.toBe(200);
  });
});

describe("a monitor's Let in checks in at the refused scan's place", () => {
  async function lobbyHold() {
    const tpl = await accessTemplate();
    const lobby = await trackedZone({ occupancy: 'enforce' });
    const vip = await trackedZone({ occupancy: 'enforce' });
    const door = await makeDoor([tpl], [lobby]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    await scanAt(door, pass);
    kit.clock.advance(5 * MINUTE);
    const hold = await scanAt(door, pass);
    expect(hold).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
    return { tpl, lobby, vip, door, pass, hold: hold.scanId as string };
  }
  const presence = (passId: string, zone: string) =>
    all<{ state: string }>(
      kit.env.DB,
      'SELECT state FROM scan_presence WHERE pass_id = ? AND scope = ?',
      [passId, `zone:${zone}`],
    );
  const rowOf = async (scanId: string) =>
    (
      await all<{ zone_id: string | null; session_id: string | null; actor_key: string }>(
        kit.env.DB,
        'SELECT zone_id, session_id, actor_key FROM scans WHERE id = ?',
        [scanId],
      )
    )[0];

  it("checks in at the lobby, not the monitor's own zone", async () => {
    const r = await lobbyHold();
    const other = await makeDoor([r.tpl], [r.vip]);
    await run(
      kit.env.DB,
      "UPDATE scanning_sessions SET settings = json_set(settings, '$.deskActions', json('true'), '$.staffSignIn', json('true'), '$.letInAgain', 'anyone') WHERE id = ?",
      [other.sessionId],
    );
    const monitor = await kit.scanner({ templateIds: [r.tpl], deviceRole: 'monitor' });
    await run(
      kit.env.DB,
      `INSERT INTO scanning_devices (scanner_id,session_id,org_id,mode,surface,effective_surface,overrides)
       SELECT id,?,org_id,mode,'desk','desk','{}' FROM scanners WHERE id=?`,
      [other.sessionId, monitor.id],
    );
    await run(
      kit.env.DB,
      `INSERT INTO scanner_setups (scanner_id, org_id, mode, watch)
       SELECT id, org_id, mode, ? FROM scanners WHERE id = ?`,
      [JSON.stringify({ scannerIds: [r.door.scanner.id], allOrg: false }), monitor.id],
    );
    await signIn(monitor.id, (await kit.staff('desk')).id);
    const res = await overrideAs(monitor.headers, r.hold);
    expect(res.status).toBe(200);
    const { scanId } = (await res.json()) as { scanId: string };
    expect(await rowOf(scanId)).toEqual({
      zone_id: r.lobby,
      session_id: r.door.sessionId,
      actor_key: `s:${monitor.id}`,
    });
    expect((await presence(r.pass.id, r.lobby))[0]?.state).toBe('in');
    expect(await presence(r.pass.id, r.vip)).toEqual([]);
  });

  it("records the refused scan's zone and session for a sessionless monitor", async () => {
    const r = await lobbyHold();
    const monitor = await standalone({ scannerIds: [r.door.scanner.id] });
    const res = await overrideAs(monitor.headers, r.hold);
    expect(res.status).toBe(200);
    const { scanId } = (await res.json()) as { scanId: string };
    expect(await rowOf(scanId)).toMatchObject({ zone_id: r.lobby, session_id: r.door.sessionId });
    expect((await presence(r.pass.id, r.lobby))[0]?.state).toBe('in');
  });

  it('does not waive another rule: a closed-hours hold stays refused', async () => {
    const r = await lobbyHold();
    await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [r.pass.id]);
    const refused = await scanAt(r.door, r.pass);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'voided' });
    const monitor = await standalone({ scannerIds: [r.door.scanner.id] });
    expect((await overrideAs(monitor.headers, refused.scanId)).status).toBe(422);
  });

  async function eventHold() {
    const templateId = await kit.scanTemplate('Event once', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'once' }],
    });
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET reentry = 1 WHERE id = ?', [event.id]);
    const door = await kit.scanner({ eventId: event.id });
    const pass = await kit.scanPass(templateId);
    const scan = async () =>
      (await (
        await kit.post(door.headers, '/actions', {
          input: codeOf(pass),
          idempotencyKey: key(),
          clientTs: kit.clock.now(),
          actionId: 'check_in',
        })
      ).json()) as { kind: string; reason: string | null; scanId: string | null };
    expect((await scan()).kind).toBe('ok');
    const hold = await scan();
    // A re-entry event is a place: the card is Already in, and a monitor may still let it in.
    expect(hold).toMatchObject({ kind: 'heads_up', reason: 'still_inside' });
    return { event, pass, hold };
  }

  it("checks a once-per-event card in at the refused scan's event for a sessionless monitor", async () => {
    const { event, pass, hold } = await eventHold();
    const monitor = await standalone({ eventId: event.id });
    const res = await overrideAs(monitor.headers, hold.scanId);
    expect(res.status).toBe(200);
    const { scanId } = (await res.json()) as { scanId: string };
    const [row] = await all<{
      event_id: string | null;
      outcome: string;
      override_of: string;
      reason: string | null;
    }>(kit.env.DB, 'SELECT event_id, outcome, override_of, reason FROM scans WHERE id = ?', [
      scanId,
    ]);
    expect(row).toEqual({
      event_id: event.id,
      outcome: 'ok',
      override_of: hold.scanId,
      reason: null,
    });
    const gates = await all<{ scope: string }>(
      kit.env.DB,
      'SELECT scope FROM scan_gates WHERE pass_id = ?',
      [pass.id],
    );
    expect(gates).toEqual([{ scope: `event:${event.id}` }]);
  });

  it('refuses when the event is edited between its reads', async () => {
    const { event, hold } = await eventHold();
    const monitor = await standalone({ eventId: event.id });
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_EPOCH_EVENT,
      async (db) => {
        await run(db, 'UPDATE scan_events SET capacity = 9 WHERE id = ?', [event.id]);
      },
      () => overrideAs(monitor.headers, hold.scanId),
    );
    expect(fired).toBe(true);
    expect(result.status).toBe(422);
    expect(await result.text()).toContain('SCAN_OVERRIDE_INVALID');
  });

  it.each([
    ['paused', "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?"],
    ['ended', "UPDATE scanning_sessions SET status = 'ended' WHERE id = ?"],
    [
      'closed',
      "UPDATE scanning_sessions SET hold = json_object('state', 'closed', 'until', 9999999999999) WHERE id = ?",
    ],
  ])('refuses a Let in when the refusing door session is %s', async (_name, sql) => {
    const r = await lobbyHold();
    await run(kit.env.DB, sql, [r.door.sessionId]);
    const monitor = await standalone({ scannerIds: [r.door.scanner.id] });
    const res = await overrideAs(monitor.headers, r.hold);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('SCAN_OVERRIDE_INVALID');
  });

  it('refuses when the refusing session is paused between the pre-read and the commit', async () => {
    const r = await lobbyHold();
    const monitor = await standalone({ scannerIds: [r.door.scanner.id] });
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_SCAN_CLAIM,
      async (db) => {
        await run(db, "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?", [
          r.door.sessionId,
        ]);
      },
      () => overrideAs(monitor.headers, r.hold),
    );
    expect(fired).toBe(true);
    expect(result.status).not.toBe(200);
    const done = await all<{ n: number }>(
      kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE override_of = ? AND outcome = 'ok'",
      [r.hold],
    );
    expect(done[0]?.n).toBe(0);
  });
});
