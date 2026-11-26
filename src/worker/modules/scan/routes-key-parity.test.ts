import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeScanStaff } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { withoutNames } from './key-names.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';
import { eventTemplate } from './template-setup-test-fixtures.ts';

const fixture = scanningSessionsFixture();
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  await fixture.setup();
  const { kit } = fixture;
  app = createApp({
    stores: {
      ...fixture.fake.stores,
      apiKeys: createApiKeyStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
});

const orgId = () => fixture.kit.org.id;
const keyOf = (scopes: string[], mode: 'live' | 'test' = 'live') =>
  makeApiKey(fixture.kit.fx, { orgId: orgId(), scopes, mode });
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    fixture.kit.env,
  );
const audit = (action: string, target: string) =>
  first<{ t: string; a: string }>(
    fixture.kit.env.DB,
    'SELECT actor_type AS t, actor_id AS a FROM audit_log WHERE action = ? AND target_id = ?',
    [action, target],
  );

describe('zones by scanning:write key', () => {
  it('creates, edits and archives a zone as the key, audited by the key', async () => {
    const k = await keyOf(['scanning:write']);
    const res = await send('POST', '/scan-zones', k.headers, {
      orgId: orgId(),
      key: 'key-gym',
      name: 'Key gym',
    });
    expect(res.status).toBe(201);
    const zone = (await res.json()) as { id: string };
    expect(
      (await send('PATCH', `/scan-zones/${zone.id}`, k.headers, { name: 'Key pool' })).status,
    ).toBe(200);
    expect((await send('POST', `/scan-zones/${zone.id}/archive`, k.headers)).status).toBe(200);
    expect(await audit('scan_zone.archive', zone.id)).toEqual({ t: 'api_key', a: k.id });
  });

  it('refuses a test key, a read-only key and another org', async () => {
    const test = await keyOf(['scanning:write'], 'test');
    expect(
      (await send('POST', '/scan-zones', test.headers, { orgId: orgId(), key: 'k-t', name: 'T' }))
        .status,
    ).toBe(403);
    const read = await keyOf(['scan-setup:read']);
    await expectProblem(
      await send('POST', '/scan-zones', read.headers, { orgId: orgId(), key: 'k-r', name: 'R' }),
      403,
      'MISSING_SCOPE',
    );
    const live = await keyOf(['scanning:write']);
    expect(
      (
        await send('POST', '/scan-zones', live.headers, {
          orgId: '0193a1b2-7c00-7000-8000-00000000ffff',
          key: 'k-o',
          name: 'O',
        })
      ).status,
    ).toBe(404);
  });

  it('lists with scan-setup:read', async () => {
    const read = await keyOf(['scan-setup:read']);
    const res = await send('GET', `/scan-zones?orgId=${orgId()}`, read.headers);
    expect(res.status).toBe(200);
  });
});

describe('scan events by scanning:write key', () => {
  it('creates and archives an event as the key', async () => {
    const k = await keyOf(['scanning:write']);
    const res = await send('POST', '/scan-events', k.headers, {
      orgId: orgId(),
      name: 'Key gala',
      templateIds: [await eventTemplate(fixture.kit, 'Key gala ticket')],
      opensAt: 1_795_129_200_000,
      closesAt: 1_795_212_000_000,
      timeZone: 'UTC',
    });
    expect(res.status).toBe(201);
    const event = (await res.json()) as { id: string };
    expect((await send('POST', `/scan-events/${event.id}/archive`, k.headers)).status).toBe(200);
    expect(await audit('scan_event.archive', event.id)).toEqual({ t: 'api_key', a: k.id });
  });
});

describe('reads by scan-setup:read key', () => {
  it('lists and reads events and sessions of its own org, not another', async () => {
    const session = await fixture.parent('Key read');
    const read = await keyOf(['scan-setup:read']);
    const list = await send('GET', `/scanning-sessions?orgId=${orgId()}`, read.headers);
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: { id: string }[] };
    expect(page.items.map((i) => i.id)).toContain(session.id);
    const one = await send('GET', `/scanning-sessions/${session.id}`, read.headers);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { activity: unknown[] }).activity).toEqual([]);
    expect((await send('GET', `/scan-events?orgId=${orgId()}`, read.headers)).status).toBe(200);
    // A key names no org: it reads its own.
    for (const path of ['/scan-events', '/scan-zones', '/scanning-sessions'])
      expect((await send('GET', path, read.headers)).status, path).toBe(200);
  });

  it('refuses a key without the scope and a test key reading live rows', async () => {
    const session = await fixture.parent('Key scope');
    const wrong = await keyOf(['scans:read']);
    expect((await send('GET', `/scanning-sessions/${session.id}`, wrong.headers)).status).toBe(403);
    const test = await keyOf(['scan-setup:read'], 'test');
    expect((await send('GET', `/scanning-sessions/${session.id}`, test.headers)).status).toBe(404);
  });

  it('answers another org with an empty page or 404', async () => {
    const read = await keyOf(['scan-setup:read']);
    const other = '0193a1b2-7c00-7000-8000-00000000ffff';
    expect(await (await send('GET', `/scan-events?orgId=${other}`, read.headers)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});

describe('session and device writes by scanning:write key', () => {
  it('edits a session, holds it and configures a device as the key, audited by the key', async () => {
    const session = await fixture.parent('Key write');
    const device = await fixture.device(session.id, 'Key device');
    const k = await keyOf(['scanning:write']);
    const edit = await send('PATCH', `/scanning-sessions/${session.id}`, k.headers, {
      name: 'Key renamed',
    });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { name: string }).name).toBe('Key renamed');
    expect(await audit('scanning.session_update', session.id)).toEqual({
      t: 'api_key',
      a: k.id,
    });
    const hold = await send('POST', `/scanning-sessions/${session.id}/hold`, k.headers, {
      action: 'clear',
    });
    expect(hold.status).toBe(200);
    const dev = await send(
      'PATCH',
      `/scanning-sessions/${session.id}/devices/${device.id}`,
      k.headers,
      { name: 'Key device 2' },
    );
    expect(dev.status).toBe(200);
    expect(await audit('scanning.device_update', device.id)).toEqual({ t: 'api_key', a: k.id });
  });

  it('refuses a read-only key, a test key and another org', async () => {
    const session = await fixture.parent('Key write refused');
    const body = { name: 'No' };
    const path = `/scanning-sessions/${session.id}`;
    const read = await keyOf(['scan-setup:read']);
    expect((await send('PATCH', path, read.headers, body)).status).toBe(403);
    const test = await keyOf(['scanning:write'], 'test');
    expect((await send('PATCH', path, test.headers, body)).status).toBe(404);
    const other = await makeApiKey(fixture.kit.fx, {
      orgId: '0193a1b2-7c00-7000-8000-00000000ffff',
      scopes: ['scanning:write'],
    }).catch(() => null);
    if (other) expect((await send('PATCH', path, other.headers, body)).status).toBe(404);
  });
});

describe('event assign and visits reset by scanning:write key', () => {
  it('assigns no scanners to an event as the key, and refuses a read-only key', async () => {
    const k = await keyOf(['scanning:write']);
    const made = await send('POST', '/scan-events', k.headers, {
      orgId: orgId(),
      name: 'Assign gala',
      templateIds: [await eventTemplate(fixture.kit, 'Assign ticket')],
      opensAt: 1_795_129_200_000,
      closesAt: 1_795_212_000_000,
      timeZone: 'UTC',
    });
    expect(made.status).toBe(201);
    const event = (await made.json()) as { id: string };
    const body = { scannerIds: [] };
    expect((await send('POST', `/scan-events/${event.id}/scanners`, k.headers, body)).status).toBe(
      200,
    );
    const read = await keyOf(['scan-setup:read']);
    expect(
      (await send('POST', `/scan-events/${event.id}/scanners`, read.headers, body)).status,
    ).toBe(403);
  });

  it('answers a visits reset for an unknown pass with 404 and a read-only key with 403', async () => {
    const id = '0193a1b2-7c00-7000-8000-00000000fffe';
    const k = await keyOf(['scanning:write']);
    expect((await send('POST', `/scan-zones/visits/${id}/reset`, k.headers)).status).toBe(404);
    const read = await keyOf(['scan-setup:read']);
    expect((await send('POST', `/scan-zones/visits/${id}/reset`, read.headers)).status).toBe(403);
  });
});

describe('scanner edit and revoke by scanning:write key', () => {
  it('edits and revokes a device as the key, and refuses a read-only key and another mode', async () => {
    const session = await fixture.parent('Key scanner');
    const device = await fixture.device(session.id, 'Key scanner device');
    const k = await keyOf(['scanning:write']);
    const read = await keyOf(['scan-setup:read']);
    const path = `/scanners/${device.id}`;
    expect((await send('PATCH', path, read.headers, { name: 'No' })).status).toBe(403);
    const test = await keyOf(['scanning:write'], 'test');
    expect((await send('PATCH', path, test.headers, { name: 'No' })).status).toBe(404);
    expect((await send('POST', `${path}/revoke`, k.headers)).status).toBe(200);
    expect(await audit('scanner.revoke', device.id)).toEqual({ t: 'api_key', a: k.id });
    // A second revoke changes nothing and still answers only to a live key.
    expect((await send('POST', `${path}/revoke`, k.headers)).status).toBe(200);
  });
});

describe('scanner mode move by scanning:write key', () => {
  it('moves a device to test mode with a live key, and refuses a test key and a read-only key', async () => {
    const made = await fixture.call('POST', '/scanners', {
      orgId: orgId(),
      name: 'Key mode scanner',
      kind: 'device',
      accepts: { templateIds: [await eventTemplate(fixture.kit, 'Mode ticket')] },
      timeZone: 'UTC',
    });
    expect(made.status).toBe(201);
    const device = (await made.json()) as { id: string };
    const path = `/scanners/${device.id}/mode`;
    const read = await keyOf(['scan-setup:read']);
    expect((await send('POST', path, read.headers, { mode: 'test' })).status).toBe(403);
    const test = await keyOf(['scanning:write'], 'test');
    expect((await send('POST', path, test.headers, { mode: 'test' })).status).toBe(404);
    const k = await keyOf(['scanning:write']);
    const moved = await send('POST', path, k.headers, { mode: 'test' });
    expect(moved.status).toBe(200);
    expect(await audit('scanner.mode_change', device.id)).toEqual({ t: 'api_key', a: k.id });
  });
});

describe('review fixes', () => {
  it('refuses a platform key on every write route and reads nothing', async () => {
    const session = await fixture.parent('Platform key');
    const device = await fixture.device(session.id, 'Platform device');
    const org = await keyOf(['scanning:write']);
    const zone = (await (
      await send('POST', '/scan-zones', org.headers, {
        orgId: orgId(),
        key: 'plat-z',
        name: 'Plat',
      })
    ).json()) as { id: string };
    const event = (await (
      await send('POST', '/scan-events', org.headers, {
        orgId: orgId(),
        name: 'Plat gala',
        templateIds: [await eventTemplate(fixture.kit, 'Plat ticket')],
        opensAt: 1_795_129_200_000,
        closesAt: 1_795_212_000_000,
        timeZone: 'UTC',
      })
    ).json()) as { id: string };
    const platform = await makeApiKey(fixture.kit.fx, {
      orgId: null,
      kind: 'platform',
      scopes: ['scanning:write', 'scan-setup:read'],
    });
    const h = platform.headers;
    const eventBody = {
      orgId: orgId(),
      name: 'Plat gala 2',
      templateIds: [await eventTemplate(fixture.kit, 'Plat ticket 2')],
      opensAt: 1_795_129_200_000,
      closesAt: 1_795_212_000_000,
      timeZone: 'UTC',
    };
    const s = session.id;
    const calls: [string, string, unknown?][] = [
      ['POST', '/scan-events', eventBody],
      ['PATCH', `/scan-events/${event.id}`, { name: 'X' }],
      ['POST', `/scan-events/${event.id}/archive`],
      ['POST', `/scan-events/${event.id}/scanners`, { scannerIds: [] }],
      ['POST', '/scan-zones', { orgId: orgId(), key: 'plat-x', name: 'X' }],
      ['PATCH', `/scan-zones/${zone.id}`, { name: 'X' }],
      ['POST', `/scan-zones/${zone.id}/archive`],
      ['POST', `/scan-zones/${zone.id}/restore`],
      ['POST', `/scan-zones/visits/${event.id}/reset`],
      ['PATCH', `/scanning-sessions/${s}`, { name: 'X' }],
      ['POST', `/scanning-sessions/${s}/hold`, { action: 'clear' }],
      ['PATCH', `/scanning-sessions/${s}/devices/${device.id}`, { name: 'X' }],
      ['PATCH', `/scanners/${device.id}`, { name: 'X' }],
      ['POST', `/scanners/${device.id}/revoke`],
      ['POST', `/scanners/${device.id}/mode`, { mode: 'test' }],
    ];
    for (const [method, path, body] of calls) {
      const res = await send(method, path, h, body);
      expect([403, 404], `${method} ${path}`).toContain(res.status);
    }
    for (const path of [`/scanning-sessions/${s}`, `/scan-events/${event.id}`]) {
      const res = await send('GET', path, h);
      expect([403, 404], path).toContain(res.status);
    }
    const lists = await send('GET', `/scan-zones?orgId=${orgId()}`, h);
    expect(((await lists.json()) as { items?: unknown[] }).items ?? []).toEqual([]);
  });

  it('names the shared-write code when a test key writes a zone', async () => {
    const test = await keyOf(['scanning:write'], 'test');
    const res = await send('POST', '/scan-zones', test.headers, {
      orgId: orgId(),
      key: 'test-z',
      name: 'T',
    });
    const body = (await res.json()) as { code: string; detail?: string };
    expect(body, JSON.stringify(body)).toMatchObject({ code: 'MODE_LIVE_REQUIRED' });
    expect(res.status).toBe(403);
  });

  it('limits holds to ten a minute per caller, charges only holds that commit, and audits by api_key', async () => {
    const session = await fixture.parent('Hold limit');
    const k = await keyOf(['scanning:write']);
    const path = `/scanning-sessions/${session.id}/hold`;
    const hold = () => send('POST', path, k.headers, { action: 'clear' });
    // A refused hold (the session is closed to nothing: nothing to open) costs no budget.
    expect((await send('POST', path, k.headers, { action: 'open', until: 1 })).status).not.toBe(
      200,
    );
    for (let i = 0; i < 10; i++) expect((await hold()).status).toBe(200);
    expect((await hold()).status).toBe(429);
    // The console has its own budget.
    expect((await fixture.call('POST', path, { action: 'clear' })).status).toBe(200);
    const row = await first<{ d: string }>(
      fixture.kit.env.DB,
      'SELECT detail AS d FROM audit_log WHERE action = ? AND target_id = ? AND actor_type = ?',
      ['scanning.session_hold_cleared', session.id, 'api_key'],
    );
    expect(JSON.parse(row?.d ?? '{}')).toMatchObject({ by: 'api_key' });
  });

  it('withholds names from a key: admin device, device edit, admin setup', async () => {
    const session = await fixture.parent('No names');
    const joined = await fixture.call('POST', '/scanning-sessions/join', {
      sessionId: session.id,
      deviceKey: crypto.randomUUID(),
    });
    expect(joined.status).toBe(200);
    const setup = await fixture.call('POST', '/scan-setups/admin-session', {
      orgId: orgId(),
      timeZone: 'UTC',
    });
    expect(setup.status).toBe(200);
    const asAdmin = (await (
      await fixture.call('GET', `/scanning-sessions/${session.id}`)
    ).json()) as { devices: { id: string; adminName: string | null }[] };
    const admin = asAdmin.devices.find((d) => d.adminName !== null);
    expect(admin, 'the console sees the admin name').toBeDefined();
    const read = await keyOf(['scan-setup:read']);
    const one = await send('GET', `/scanning-sessions/${session.id}`, read.headers);
    const body = (await one.json()) as { devices: { adminName: string | null }[] };
    expect(body.devices.length).toBeGreaterThan(0);
    expect(body.devices.every((d) => d.adminName === null)).toBe(true);
    const write = await keyOf(['scanning:write']);
    const edit = await send(
      'PATCH',
      `/scanning-sessions/${session.id}/devices/${admin?.id}`,
      write.headers,
      { name: 'Renamed by key' },
    );
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { adminName: string | null }).adminName).toBeNull();
    const setups = await send('GET', `/scan-setups?orgId=${orgId()}`, read.headers);
    const items = ((await setups.json()) as { items: { adminUser: { name: unknown } | null }[] })
      .items;
    expect(items.some((i) => i.adminUser !== null)).toBe(true);
    for (const i of items) if (i.adminUser) expect(i.adminUser.name).toBeNull();
  });

  it('moves a scanner either way with a live key, and a test key never touches a live scanner', async () => {
    const made = await fixture.call('POST', '/scanners', {
      orgId: orgId(),
      name: 'Round trip',
      kind: 'device',
      accepts: { templateIds: [await eventTemplate(fixture.kit, 'Round ticket')] },
      timeZone: 'UTC',
    });
    const scanner = (await made.json()) as { id: string };
    const path = `/scanners/${scanner.id}/mode`;
    const live = await keyOf(['scanning:write']);
    const test = await keyOf(['scanning:write'], 'test');
    expect((await send('POST', path, live.headers, { mode: 'test' })).status).toBe(200);
    expect((await send('POST', path, live.headers, { mode: 'live' })).status).toBe(200);
    expect((await send('POST', path, test.headers, { mode: 'test' })).status).toBe(404);
    expect((await send('POST', path, live.headers, { mode: 'test' })).status).toBe(200);
    // A test scanner is reachable from a live key (to go live), not from a test key to touch live rows.
    expect((await send('POST', path, test.headers, { mode: 'live' })).status).toBe(403);
  });

  it('refuses a platform key on the setup dry run, the apply and a template scan setup', async () => {
    const platform = await makeApiKey(fixture.kit.fx, {
      orgId: null,
      kind: 'platform',
      scopes: ['scanning:write'],
    });
    const template = await eventTemplate(fixture.kit, 'Platform setup ticket', {
      scan: { actions: [{ id: 'enter', label: 'Let in', kind: 'check_in' }] },
    });
    // A session exists for the template, so nothing needs writing: the old path returned it unproved.
    const org = await keyOf(['scanning:write']);
    expect(
      (
        await send('POST', `/templates/${template}/scan-setup`, org.headers, {
          orgId: orgId(),
          timeZone: 'UTC',
        })
      ).status,
    ).toBe(200);
    const intent = {
      orgId: orgId(),
      preset: 'venue',
      doors: [{ name: 'Platform door', admits: { templateIds: [template] } }],
    };
    const h = { ...platform.headers, 'idempotency-key': crypto.randomUUID() };
    expect((await send('POST', '/scanning-sessions/setup?dryRun=true', h, intent)).status).toBe(
      404,
    );
    expect((await send('POST', '/scanning-sessions/setup', h, intent)).status).toBe(404);
    expect(
      (
        await send('POST', `/templates/${template}/scan-setup`, platform.headers, {
          orgId: orgId(),
          timeZone: 'UTC',
        })
      ).status,
    ).toBe(404);
    const setups = await send('GET', `/scan-setups?orgId=${orgId()}`, platform.headers);
    expect(((await setups.json()) as { items?: unknown[] }).items ?? []).toEqual([]);
    const [row] = await all<{ id: string }>(
      fixture.kit.env.DB,
      'SELECT id FROM scanners WHERE org_id = ? LIMIT 1',
      [orgId()],
    );
    expect(
      (await send('GET', `/scan-setups/${row?.id}`, platform.headers)).status,
    ).toBeGreaterThanOrEqual(403);
  });

  it('withoutNames nulls staff and admin names and keeps the ids', () => {
    const out = withoutNames({
      staff: { id: 's1', name: 'Maya Chen' },
      adminUser: { id: 'u1', name: 'Sam Ortiz' },
      other: 1,
    });
    expect(out).toEqual({
      staff: { id: 's1', name: null },
      adminUser: { id: 'u1', name: null },
      other: 1,
    });
    expect(withoutNames({ staff: null })).toEqual({ staff: null });
  });

  it('nulls staff.name on the scanner edit, revoke and mode answers for a key', async () => {
    const made = await fixture.call('POST', '/scanners', {
      orgId: orgId(),
      name: 'Staffed scanner',
      kind: 'device',
      accepts: { templateIds: [await eventTemplate(fixture.kit, 'Staffed ticket')] },
      timeZone: 'UTC',
    });
    const scanner = (await made.json()) as { id: string };
    const staff = await makeScanStaff(fixture.kit.fx, { orgId: orgId(), name: 'Maya Chen' });
    const now = fixture.kit.clock.now();
    // A mode move or a revoke unbinds the staff member, so each call starts bound.
    const bind = () =>
      run(
        fixture.kit.env.DB,
        'UPDATE scanners SET staff_id = ?, staff_since = ?, staff_seen_at = ? WHERE id = ?',
        [staff.id, now, now, scanner.id],
      );
    await bind();
    const k = await keyOf(['scanning:write']);
    const named = async (res: Response) => {
      expect(res.status).toBe(200);
      return ((await res.json()) as { staff: { id: string; name: string | null } | null }).staff;
    };
    const path = `/scanners/${scanner.id}`;
    expect(await named(await send('PATCH', path, k.headers, { name: 'Staffed 2' }))).toEqual({
      id: staff.id,
      name: null,
    });
    for (const mode of ['test', 'live']) {
      await bind();
      expect(await named(await send('POST', `${path}/mode`, k.headers, { mode }))).toEqual({
        id: staff.id,
        name: null,
      });
    }
    await bind();
    // A revoke unbinds the staff member, so its answer has none; a name is never in it.
    const revoked = await named(await send('POST', `${path}/revoke`, k.headers));
    expect(revoked?.name ?? null).toBeNull();
    // The console still sees the name.
    await bind();
    const view = await fixture.call('GET', path);
    expect(((await view.json()) as { staff: { name: string } | null }).staff?.name).toBe(
      'Maya Chen',
    );
  });

  it('never lets a parallel burst of holds from one key pass the limit', async () => {
    const session = await fixture.parent('Hold burst');
    const k = await keyOf(['scanning:write']);
    const path = `/scanning-sessions/${session.id}/hold`;
    const results = await Promise.all(
      Array.from({ length: 16 }, () => send('POST', path, k.headers, { action: 'clear' })),
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeLessThanOrEqual(10);
    expect(results.filter((r) => r.status === 429).length).toBe(16 - ok);
  });

  it('counts zone sessions in the key mode only, in the list and the write answers', async () => {
    const { DB } = fixture.kit.env;
    const k = await keyOf(['scanning:write']);
    const made = await send('POST', '/scan-zones', k.headers, {
      orgId: orgId(),
      key: 'mode-count',
      name: 'Mode count',
    });
    const zone = (await made.json()) as { id: string };
    const live = await fixture.parent('Zone count live');
    await run(
      DB,
      `INSERT INTO scanning_sessions(id,org_id,mode,name,status,settings,time_zone,created_at,updated_at)
       VALUES ('zc-test',?,'test','zc-test','active','{}','UTC',1,1)`,
      [orgId()],
    );
    for (const id of [live.id, 'zc-test'])
      await run(DB, 'INSERT INTO scanning_session_zones(session_id, zone_id) VALUES (?, ?)', [
        id,
        zone.id,
      ]);
    type Z = { id: string; sessions: number };
    const count = async (res: Response, list: boolean) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as Z | { items: Z[] };
      return list
        ? (body as { items: Z[] }).items.find((z) => z.id === zone.id)?.sessions
        : (body as Z).sessions;
    };
    const read = await keyOf(['scan-setup:read']);
    expect(await count(await send('GET', `/scan-zones?orgId=${orgId()}`, read.headers), true)).toBe(
      1,
    );
    expect(
      await count(
        await send('PATCH', `/scan-zones/${zone.id}`, k.headers, { name: 'Mode count 2' }),
        false,
      ),
    ).toBe(1);
    // The console keeps every session that uses the zone.
    expect(await count(await fixture.call('GET', `/scan-zones?orgId=${orgId()}`), true)).toBe(2);
  });
});
