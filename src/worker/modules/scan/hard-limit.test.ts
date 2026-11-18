import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { ACCESS, accessTemplate, makeZone, uid } from './access-test-fixtures.ts';
import { kit, setupActionFixture } from './act-test-fixtures.ts';
import { scanAt, trackedZone } from './occupancy-scan-test-fixtures.ts';
import { bodyOf, doorAndMonitor, overrideAs } from './overrides-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

/** A full gym at the door: the second person is held. `hard` sets the zone's own Hard limit. */
async function fullZone(hard: boolean, o: Parameters<typeof doorAndMonitor>[2] = {}) {
  const tpl = await accessTemplate();
  const gym = await trackedZone({ occupancy: 'enforce', capacity: 1 });
  if (hard) await run(kit.env.DB, 'UPDATE scan_zones SET hard_limit = 1 WHERE id = ?', [gym]);
  const rig = await doorAndMonitor(tpl, [gym], o);
  await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
  const held = await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
  expect(held).toMatchObject({ kind: 'heads_up', reason: 'capacity_full' });
  return { ...rig, held, gym };
}

describe('a zone Hard limit', () => {
  it('without it, Full is overridable and the override goes through', async () => {
    const r = await fullZone(false);
    expect(r.held.overridable).toBe(true);
    expect(await bodyOf(await overrideAs(r.monitor.headers, r.held.scanId))).toMatchObject({
      kind: 'ok',
    });
  });

  it.each(['door', 'desk'] as const)(
    'is final for a %s person: no Let in, no override',
    async (role) => {
      const r = await fullZone(true, { role });
      expect(r.held.overridable).toBe(false);
      expect((await overrideAs(r.monitor.headers, r.held.scanId)).status).toBe(403);
    },
  );

  it('is final for a Manager too', async () => {
    const r = await fullZone(true, { role: 'manager' });
    expect(r.held.overridable).toBe(false);
    expect((await overrideAs(r.monitor.headers, r.held.scanId)).status).toBe(403);
  });

  it('holds for a parent zone: a full, hard-limited site is final for a room under it', async () => {
    const tpl = await accessTemplate();
    const site = await trackedZone({ occupancy: 'track', capacity: 1 });
    await run(kit.env.DB, 'UPDATE scan_zones SET hard_limit = 1 WHERE id = ?', [site]);
    const room = await trackedZone({ occupancy: 'track', parentId: site });
    const rig = await doorAndMonitor(tpl, [room], {});
    await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    const held = await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'capacity_full', overridable: false });
    expect((await overrideAs(rig.monitor.headers, held.scanId)).status).toBe(403);
  });

  it('leaves the door switch as an extra: it still closes a zone with no Hard limit', async () => {
    const r = await fullZone(false, { hardLimit: true });
    expect(r.held.overridable).toBe(false);
    expect((await overrideAs(r.monitor.headers, r.held.scanId)).status).toBe(403);
  });
});

describe('a session with an access zone and a different place', () => {
  it('closes Full at the place the entry counts at, not the zone that granted it', async () => {
    const lobbyKey = `lobby-${uid()}`;
    const lobby = await makeZone(lobbyKey);
    const tpl = await accessTemplate({
      ...ACCESS,
      plans: [
        { id: 'lobby_only', label: 'Lobby only', kind: 'always', zones: [{ zone: lobbyKey }] },
      ],
    });
    // Pool counts people (it is the session's first tracked zone); the plan opens only the Lobby.
    const pool = await trackedZone({ occupancy: 'track', capacity: 1 });
    await run(kit.env.DB, 'UPDATE scan_zones SET hard_limit = 1 WHERE id = ?', [pool]);
    const rig = await doorAndMonitor(tpl, [pool, lobby], {});
    await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'lobby_only' }));
    const held = await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'lobby_only' }));
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'capacity_full', overridable: false });
    expect((await overrideAs(rig.monitor.headers, held.scanId)).status).toBe(403);
  });
});

describe('a parent Hard limit and a full child', () => {
  it('is final on the verdict and on the override alike, and says why', async () => {
    const tpl = await accessTemplate();
    const site = await trackedZone({ occupancy: 'track' });
    await run(kit.env.DB, 'UPDATE scan_zones SET hard_limit = 1, capacity = 50 WHERE id = ?', [
      site,
    ]);
    const room = await trackedZone({ occupancy: 'track', capacity: 1, parentId: site });
    const rig = await doorAndMonitor(tpl, [room], {});
    await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    const held = await scanAt(rig.door, await kit.scanPass(tpl, { plan: 'gold' }));
    expect(held).toMatchObject({ reason: 'capacity_full', overridable: false });
    const res = await overrideAs(rig.monitor.headers, held.scanId);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Full. No one can let them in.');
  });
});

describe('an event Hard limit', () => {
  async function fullEvent(hard: boolean) {
    const templateId = await kit.scanTemplate('Hard limit event', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const event = await kit.event({ templateIds: [templateId] });
    await run(kit.env.DB, 'UPDATE scan_events SET capacity = 1, hard_limit = ? WHERE id = ?', [
      hard ? 1 : 0,
      event.id,
    ]);
    const scanner = await kit.scanner({ eventId: event.id, settings: { direction: 'in' } });
    const check = async () => {
      const res = await kit.post(scanner.headers, '/actions', {
        input: codeOf(await kit.scanPass(templateId)),
        idempotencyKey: key(),
        clientTs: kit.clock.now(),
        actionId: 'check_in',
      });
      return (await res.json()) as {
        kind: string;
        reason: string | null;
        overridable: boolean;
        event?: { name: string; startsAt: number } | null;
      };
    };
    expect(await check()).toMatchObject({ kind: 'ok' });
    return check();
  }

  it('offers Let in without it, and names the event', async () => {
    const full = await fullEvent(false);
    expect(full).toMatchObject({ reason: 'capacity_full', overridable: true });
    expect(full.event?.name).toEqual(expect.any(String));
    expect(full.event?.startsAt).toEqual(expect.any(Number));
  });

  it('offers nothing with it', async () => {
    expect(await fullEvent(true)).toMatchObject({ reason: 'capacity_full', overridable: false });
  });
});

describe('an event Hard limit is part of its configuration epoch', () => {
  it('bumps config_epoch when it changes, and not when it is set to what it was', async () => {
    const event = await kit.event({
      templateIds: [await kit.scanTemplate('Epoch', { actions: [] })],
    });
    const epoch = async () =>
      (
        await first<{ config_epoch: number }>(
          kit.env.DB,
          'SELECT config_epoch FROM scan_events WHERE id = ?',
          [event.id],
        )
      )?.config_epoch ?? 0;
    const before = await epoch();
    await run(kit.env.DB, 'UPDATE scan_events SET hard_limit = 1 WHERE id = ?', [event.id]);
    expect(await epoch()).toBe(before + 1);
    await run(kit.env.DB, 'UPDATE scan_events SET hard_limit = 1 WHERE id = ?', [event.id]);
    expect(await epoch()).toBe(before + 1);
    await run(kit.env.DB, 'UPDATE scan_events SET hard_limit = 0 WHERE id = ?', [event.id]);
    expect(await epoch()).toBe(before + 2);
  });
});
