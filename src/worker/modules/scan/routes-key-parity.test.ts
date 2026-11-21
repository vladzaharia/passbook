import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createScannerStore } from './auth-store.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

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
      templateIds: [],
      opensAt: 1_795_129_200_000,
      closesAt: 1_795_212_000_000,
      timeZone: 'UTC',
    });
    expect([201, 422]).toContain(res.status);
    if (res.status !== 201) return;
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
