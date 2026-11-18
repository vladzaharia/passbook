import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeScanEvent, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanZone } from '../../../shared/contracts/scan-access.ts';
import { all, first } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const fixture = scanningSessionsFixture();
let orgB: string;
let zoneB: ScanZone;
let outsider: Record<string, string>;

let seq = 0;
async function zoneIn(orgId: string, extra: Record<string, unknown> = {}): Promise<ScanZone> {
  const k = `t${(seq++).toString(36)}`;
  const res = await fixture.call('POST', '/scan-zones', {
    orgId,
    key: k,
    name: `Zone ${k}`,
    ...extra,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ScanZone;
}
const count = async (sql: string, params: (string | number)[] = []) =>
  (await first<{ n: number }>(fixture.kit.env.DB, sql, params))?.n ?? 0;
const links = (sessionId: string) =>
  all<{ zone_id: string }>(
    fixture.kit.env.DB,
    'SELECT zone_id FROM scanning_session_zones WHERE session_id = ? ORDER BY sort',
    [sessionId],
  ).then((rows) => rows.map((r) => r.zone_id));
const epoch = async (sessionId: string) =>
  (
    await first<{ e: number }>(
      fixture.kit.env.DB,
      'SELECT config_epoch AS e FROM scanning_sessions WHERE id = ?',
      [sessionId],
    )
  )?.e ?? 0;

beforeAll(async () => {
  await fixture.setup();
  const { kit, fake } = fixture;
  orgB = (await makeOrg(kit.fx)).id;
  await grantScanMembership(kit.fx, orgB, 'admin-1');
  zoneB = await zoneIn(orgB);
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  outsider = fake.session({ userId: user.id, roles: ['user'] });
});

describe('zones: tenants', () => {
  it('refuses a foreign parent on create and inserts nothing', async () => {
    const before = await count('SELECT count(*) AS n FROM scan_zones');
    const res = await fixture.call('POST', '/scan-zones', {
      orgId: fixture.kit.org.id,
      key: 'steal',
      name: 'Steal',
      parentId: zoneB.id,
    });
    await expectProblem(res, 404, 'ZONE_NOT_FOUND');
    expect(await count('SELECT count(*) AS n FROM scan_zones')).toBe(before);
  });

  it('refuses a foreign parent on a move, and leaves the zone where it was', async () => {
    const own = await zoneIn(fixture.kit.org.id);
    await expectProblem(
      await fixture.call('PATCH', `/scan-zones/${own.id}`, { parentId: zoneB.id }),
      404,
      'ZONE_NOT_FOUND',
    );
    expect(
      await first(fixture.kit.env.DB, 'SELECT parent_id FROM scan_zones WHERE id = ?', [own.id]),
    ).toEqual({ parent_id: null });
  });

  it('answers a member of another org with 404 for edits and an empty list for reads', async () => {
    const mine = await zoneIn(fixture.kit.org.id);
    // The outsider is an admin of org A only: org B's zone does not exist for them.
    for (const [path, method, body] of [
      [`/${zoneB.id}`, 'PATCH', { name: 'Mine now' }],
      [`/${zoneB.id}/archive`, 'POST', undefined],
      [`/${zoneB.id}/restore`, 'POST', undefined],
    ] as const)
      await expectProblem(
        await fixture.call(method, `/scan-zones${path}`, body, outsider),
        404,
        'ZONE_NOT_FOUND',
      );
    const list = await fixture.call('GET', `/scan-zones?orgId=${orgB}`, undefined, outsider);
    expect(await list.json()).toEqual({ items: [], nextCursor: null });
    expect(
      await first<{ name: string; archived_at: number | null }>(
        fixture.kit.env.DB,
        'SELECT name, archived_at FROM scan_zones WHERE id = ?',
        [zoneB.id],
      ),
    ).toEqual({ name: zoneB.name, archived_at: null });
    const own = await fixture.call(
      'GET',
      `/scan-zones?orgId=${fixture.kit.org.id}`,
      undefined,
      outsider,
    );
    expect(((await own.json()) as { items: { id: string }[] }).items.map((z) => z.id)).toContain(
      mine.id,
    );
    expect(
      ((await own.json().catch(() => ({ items: [] }))) as { items: unknown[] }).items,
    ).toBeDefined();
  });

  it('does not list a foreign org through the orgId of one the user can reach', async () => {
    const res = await fixture.call('GET', `/scan-zones?orgId=${fixture.kit.org.id}`);
    const ids = ((await res.json()) as { items: { id: string }[] }).items.map((z) => z.id);
    expect(ids).not.toContain(zoneB.id);
  });
});

describe('zones: session links', () => {
  it('links zones in order, replaces them, clears them, and bumps the session epoch each time', async () => {
    const [z1, z2] = [await zoneIn(fixture.kit.org.id), await zoneIn(fixture.kit.org.id)];
    const session = await fixture.parent('Pool door');
    const e0 = await epoch(session.id);
    const set = async (zoneIds: string[]) => {
      const res = await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds });
      expect(res.status).toBe(200);
      return ((await res.json()) as { zoneIds: string[] }).zoneIds;
    };
    expect(await set([z2.id, z1.id])).toEqual([z2.id, z1.id]);
    const e1 = await epoch(session.id);
    expect(e1).toBeGreaterThan(e0);
    expect(await set([z1.id])).toEqual([z1.id]);
    expect(await epoch(session.id)).toBeGreaterThan(e1);
    const e2 = await epoch(session.id);
    expect(await set([])).toEqual([]);
    expect(await links(session.id)).toEqual([]);
    expect(await epoch(session.id)).toBeGreaterThan(e2);
    const detail = await fixture.call('GET', `/scanning-sessions/${session.id}`);
    expect(((await detail.json()) as { zoneIds: string[] }).zoneIds).toEqual([]);
  });

  it('takes zones when the session is created', async () => {
    const z = await zoneIn(fixture.kit.org.id);
    const res = await fixture.call('POST', '/scanning-sessions', {
      orgId: fixture.kit.org.id,
      name: 'Gym door',
      timeZone: 'UTC',
      zoneIds: [z.id],
    });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string; zoneIds: string[] };
    expect(made.zoneIds).toEqual([z.id]);
    expect(await links(made.id)).toEqual([z.id]);
  });

  it('refuses a foreign zone: 404, no link, no session', async () => {
    const session = await fixture.parent('Foreign link');
    const e0 = await epoch(session.id);
    await expectProblem(
      await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds: [zoneB.id] }),
      404,
      'ZONE_NOT_FOUND',
    );
    expect(await links(session.id)).toEqual([]);
    expect(await epoch(session.id)).toBe(e0);
    await expectProblem(
      await fixture.call('POST', '/scanning-sessions', {
        orgId: fixture.kit.org.id,
        name: 'Born foreign',
        timeZone: 'UTC',
        zoneIds: [zoneB.id],
      }),
      404,
      'ZONE_NOT_FOUND',
    );
    expect(
      await count("SELECT count(*) AS n FROM scanning_sessions WHERE name = 'Born foreign'"),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM scanning_session_zones WHERE zone_id = ?', [zoneB.id]),
    ).toBe(0);
  });

  it('refuses nine zones and a repeated zone', async () => {
    const session = await fixture.parent('Too many');
    const ids = await Promise.all(
      Array.from({ length: 9 }, () => zoneIn(fixture.kit.org.id).then((z) => z.id)),
    );
    for (const zoneIds of [ids, [ids[0], ids[0]]])
      expect(
        (await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds })).status,
      ).toBe(422);
    expect(await links(session.id)).toEqual([]);
  });

  it('refuses a new link to an archived zone, and keeps an old one until the list drops it', async () => {
    const [keep, fresh] = [await zoneIn(fixture.kit.org.id), await zoneIn(fixture.kit.org.id)];
    const session = await fixture.parent('Archived link');
    await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds: [keep.id] });
    await fixture.call('POST', `/scan-zones/${keep.id}/archive`);
    await fixture.call('POST', `/scan-zones/${fresh.id}/archive`);
    await expectProblem(
      await fixture.call('PATCH', `/scanning-sessions/${session.id}`, {
        zoneIds: [keep.id, fresh.id],
      }),
      422,
      'ZONE_ARCHIVED',
    );
    expect(await links(session.id)).toEqual([keep.id]);
    const drop = await fixture.call('PATCH', `/scanning-sessions/${session.id}`, { zoneIds: [] });
    expect(drop.status).toBe(200);
    expect(await links(session.id)).toEqual([]);
  });

  it('keeps zones off event sessions', async () => {
    const z = await zoneIn(fixture.kit.org.id);
    const event = await makeScanEvent(fixture.kit.fx, {
      orgId: fixture.kit.org.id,
      templateIds: [fixture.kit.template.id],
    });
    const res = await fixture.call('POST', '/scanning-sessions', {
      orgId: fixture.kit.org.id,
      name: 'Eventful',
      timeZone: 'UTC',
      accepts: { eventId: event.id },
      zoneIds: [z.id],
    });
    await expectProblem(res, 422, 'ZONE_EVENT_SESSION');
  });
});
