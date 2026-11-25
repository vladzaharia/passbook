import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../shared/contracts/scan-access.ts';
import { all, first, run } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

let seq = 0;
const key = () => `z${(seq++).toString(36)}`;
const zones = (path = '', method = 'GET', body?: unknown, headers?: Record<string, string>) =>
  fixture.call(method, `/scan-zones${path}`, body, headers);
async function make(extra: Record<string, unknown> = {}): Promise<ScanZone> {
  const k = key();
  const res = await zones('', 'POST', {
    orgId: fixture.kit.org.id,
    key: k,
    name: `Zone ${k}`,
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
}
const list = async (query = '') => {
  const res = await zones(`?orgId=${fixture.kit.org.id}${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: ScanZone[]; nextCursor: string | null }).items;
};

describe('zones: create and read', () => {
  it('creates a root with a time zone, and a child that inherits it', async () => {
    const root = await make({ timeZone: 'Europe/London' });
    expect(root).toMatchObject({
      depth: 0,
      parentId: null,
      effectiveTimeZone: 'Europe/London',
      archivedAt: null,
      occupancy: 'off',
    });
    const child = await make({ parentId: root.id });
    expect(child).toMatchObject({ depth: 1, timeZone: null, effectiveTimeZone: 'Europe/London' });
    const ids = (await list()).map((z) => z.id);
    expect(ids.indexOf(child.id)).toBe(ids.indexOf(root.id) + 1);
  });

  it('refuses a child time zone, a bad key, a taken key and a taken name', async () => {
    const root = await make();
    const org = fixture.kit.org.id;
    await expectProblem(
      await zones('', 'POST', {
        orgId: org,
        key: key(),
        name: 'x1',
        parentId: root.id,
        timeZone: 'UTC',
      }),
      422,
      'ZONE_CHILD_TZ',
    );
    for (const bad of ['Pool', 'a b', '*', '-x'])
      expect((await zones('', 'POST', { orgId: org, key: bad, name: 'Bad' })).status).toBe(422);
    await expectProblem(
      await zones('', 'POST', { orgId: org, key: root.key, name: 'Other' }),
      409,
      'ZONE_KEY_TAKEN',
    );
    await expectProblem(
      await zones('', 'POST', { orgId: org, key: key(), name: root.name.toUpperCase() }),
      409,
      'ZONE_NAME_TAKEN',
    );
  });

  it('keeps occupancy limits behind tracking, and clear at on the org clock', async () => {
    const org = fixture.kit.org.id;
    expect(
      (await zones('', 'POST', { orgId: org, key: key(), name: 'Cap', capacity: 5 })).status,
    ).toBe(422);
    // Every org has a clock, so a root without its own zone still takes a clear time.
    expect(
      (
        await zones('', 'POST', {
          orgId: org,
          key: key(),
          name: 'Clr',
          occupancy: 'track',
          clearAt: '03:00',
        })
      ).status,
    ).toBe(201);
    const gym = await make({
      occupancy: 'enforce',
      capacity: 40,
      timeZone: 'UTC',
      clearAt: '03:00',
    });
    expect(gym).toMatchObject({ occupancy: 'enforce', capacity: 40, clearAt: '03:00' });
    const off = await zones(`/${gym.id}`, 'PATCH', { occupancy: 'off' });
    await expectProblem(off, 422, 'ZONE_NEEDS_TRACKING');
    const cleared = await zones(`/${gym.id}`, 'PATCH', {
      occupancy: 'off',
      capacity: null,
      clearAt: null,
    });
    expect(await cleared.json()).toMatchObject({ occupancy: 'off', capacity: null });
    const tz = await make({ occupancy: 'track', timeZone: 'UTC', clearAt: '04:00' });
    expect((await zones(`/${tz.id}`, 'PATCH', { timeZone: null })).status).toBe(200);
  });
});

describe('zones: edit and tree rules', () => {
  it('renames, sorts and moves a zone, and refuses a cycle and a fifth level', async () => {
    const a = await make({ timeZone: 'UTC' });
    const b = await make({ parentId: a.id });
    const c = await make({ parentId: b.id });
    const d = await make({ parentId: c.id });
    expect(d.depth).toBe(3);
    const org = fixture.kit.org.id;
    await expectProblem(
      await zones('', 'POST', { orgId: org, key: key(), name: 'Five', parentId: d.id }),
      422,
      'ZONE_DEPTH',
    );
    await expectProblem(await zones(`/${a.id}`, 'PATCH', { parentId: c.id }), 422, 'ZONE_CYCLE');
    await expectProblem(await zones(`/${a.id}`, 'PATCH', { parentId: a.id }), 422, 'ZONE_CYCLE');
    const other = await make();
    await expectProblem(
      await zones(`/${other.id}`, 'PATCH', { parentId: d.id }),
      422,
      'ZONE_DEPTH',
    );
    const moved = await zones(`/${d.id}`, 'PATCH', { parentId: a.id, name: 'Moved', sort: 9 });
    expect(await moved.json()).toMatchObject({ parentId: a.id, name: 'Moved', sort: 9, depth: 1 });
    // A top zone with a time zone cannot move under another without giving it up.
    await expectProblem(
      await zones(`/${other.id}`, 'PATCH', { parentId: a.id, timeZone: 'UTC' }),
      422,
      'ZONE_CHILD_TZ',
    );
  });

  it('ignores a key in the body: keys never change', async () => {
    const z = await make();
    expect((await zones(`/${z.id}`, 'PATCH', { key: 'other' })).status).toBe(422);
  });
});

describe('zones: archive and restore', () => {
  it('archives a zone with the zones below it, keeps session links, and restores them', async () => {
    const root = await make({ timeZone: 'UTC' });
    const child = await make({ parentId: root.id });
    const session = await fixture.parent('Door');
    const link = await fixture.call('PATCH', `/scanning-sessions/${session.id}`, {
      zoneIds: [child.id],
    });
    expect(link.status).toBe(200);
    const res = await zones(`/${root.id}/archive`, 'POST');
    expect(await res.json()).toMatchObject({ id: root.id, archivedAt: expect.any(Number) });
    const archived = await list('&archived=true');
    expect(archived.map((z) => z.id)).toEqual(expect.arrayContaining([root.id, child.id]));
    expect((await list()).some((z) => z.id === child.id)).toBe(false);
    const links = await all(
      fixture.kit.env.DB,
      'SELECT zone_id FROM scanning_session_zones WHERE session_id = ?',
      [session.id],
    );
    expect(links).toHaveLength(1);
    // The child cannot come back under an archived parent; the parent brings it back.
    await expectProblem(await zones(`/${child.id}/restore`, 'POST'), 422, 'ZONE_PARENT_ARCHIVED');
    expect((await zones(`/${root.id}/restore`, 'POST')).status).toBe(200);
    const live = await list();
    expect(live.map((z) => z.id)).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(live.find((z) => z.id === child.id)?.sessions).toBe(1);
  });

  it('names the sessions that check a zone', async () => {
    const z = await make();
    const lone = await make();
    const session = await fixture.parent('Lab door');
    expect(
      (await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds: [z.id] })).status,
    ).toBe(200);
    const live = await list();
    expect(live.find((r) => r.id === z.id)?.checkedAt).toEqual([
      { id: session.id, name: 'Lab door' },
    ]);
    expect(live.find((r) => r.id === lone.id)?.checkedAt).toEqual([]);
  });

  it('leaves out ended sessions, other modes and other orgs', async () => {
    const { DB } = fixture.kit.env;
    const z = await make();
    const open = await fixture.parent('Open door');
    const ended = await fixture.parent('Ended door');
    const other = await makeOrg(fixture.kit.fx);
    const add = (id: string, orgId: string, mode: string, status: string) =>
      run(
        DB,
        `INSERT INTO scanning_sessions(id,org_id,mode,name,status,settings,time_zone,created_at,updated_at)
         VALUES (?,?,?,?,?,'{}','UTC',1,1)`,
        [id, orgId, mode, id, status],
      );
    await add('s-test', fixture.kit.org.id, 'test', 'active');
    await add('s-foreign', other.id, 'live', 'active');
    await run(DB, "UPDATE scanning_sessions SET status = 'ended' WHERE id = ?", [ended.id]);
    for (const id of [open.id, ended.id, 's-test', 's-foreign'])
      await run(DB, 'INSERT INTO scanning_session_zones(session_id, zone_id) VALUES (?, ?)', [
        id,
        z.id,
      ]);
    expect((await list()).find((r) => r.id === z.id)?.checkedAt).toEqual([
      { id: open.id, name: 'Open door' },
    ]);
  });

  it('refuses edits to an archived zone, and a restore into a taken name', async () => {
    const z = await make();
    await zones(`/${z.id}/archive`, 'POST');
    await expectProblem(await zones(`/${z.id}`, 'PATCH', { name: 'Late' }), 422, 'ZONE_ARCHIVED');
    const twin = await fixture.call('POST', '/scan-zones', {
      orgId: fixture.kit.org.id,
      key: key(),
      name: z.name,
    });
    expect(twin.status).toBe(201);
    await expectProblem(await zones(`/${z.id}/restore`, 'POST'), 409, 'ZONE_NAME_TAKEN');
  });
});

describe('zones: who may', () => {
  it('lets a reader list and refuses a reader every write', async () => {
    const { kit, fake } = fixture;
    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const headers = fake.session({ userId: reader.id, roles: ['user'] });
    const z = await make();
    const read = await zones(`?orgId=${kit.org.id}`, 'GET', undefined, headers);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      z.id,
    );
    for (const [path, method, body] of [
      ['', 'POST', { orgId: kit.org.id, key: key(), name: 'Nope' }],
      [`/${z.id}`, 'PATCH', { name: 'Nope' }],
      [`/${z.id}/archive`, 'POST', undefined],
    ] as const)
      expect((await zones(path, method, body, headers)).status, path).toBe(403);
    expect(
      (
        await first<{ name: string }>(kit.env.DB, 'SELECT name FROM scan_zones WHERE id = ?', [
          z.id,
        ])
      )?.name,
    ).toBe(z.name);
  });

  it('audits create, update, archive and restore', async () => {
    const z = await make();
    await zones(`/${z.id}`, 'PATCH', { name: `${z.name}!` });
    await zones(`/${z.id}/archive`, 'POST');
    await zones(`/${z.id}/restore`, 'POST');
    const rows = await all<{ action: string }>(
      fixture.kit.env.DB,
      "SELECT action FROM audit_log WHERE target_id = ? AND action LIKE 'scan_zone.%' ORDER BY rowid",
      [z.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'scan_zone.create',
      'scan_zone.update',
      'scan_zone.archive',
      'scan_zone.restore',
    ]);
  });
});
