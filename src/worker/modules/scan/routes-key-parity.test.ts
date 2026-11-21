import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
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
