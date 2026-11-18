import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { type Api, auditOf, BASE, GOOD, rowCount, setupApi, wipe } from './api-test-fixtures.ts';
import { type Net, stubNet } from './deliver-test-fixtures.ts';

let api: Api;
let net: Net;
let orgId: string;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
  orgId = api.rig.orgId;
});
afterAll(() => net.restore());
beforeEach(async () => {
  await wipe(api.rig);
  net.calls.length = 0;
  api.resetLimits();
});

const create = (headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  api.call('POST', BASE, { orgId, ...GOOD, ...extra }, headers);

describe('sessions', () => {
  it('lets org admins and integration admins read and manage', async () => {
    for (const role of ['org_admin', 'integration_admin'] as const) {
      const h = await api.member([role]);
      const made = await create(h);
      expect(made.status).toBe(201);
      expect(made.json.endpoint.url).toBe(GOOD.url);
      const id = made.json.endpoint.id as string;
      expect((await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, h)).status).toBe(200);
      expect((await api.call('PATCH', `${BASE}/${id}`, { description: 'x' }, h)).status).toBe(200);
      expect((await api.call('POST', `${BASE}/${id}/secret`, {}, h)).status).toBe(200);
      expect((await api.call('POST', `${BASE}/${id}/test`, undefined, h)).status).toBe(200);
      expect((await api.call('GET', `${BASE}/${id}/deliveries`, undefined, h)).status).toBe(200);
      expect((await api.call('POST', `${BASE}/${id}/replay`, { from: 0, to: 1 }, h)).status).toBe(
        200,
      );
      expect((await api.call('DELETE', `${BASE}/${id}`, undefined, h)).status).toBe(200);
    }
  });

  it('shows a read-only member the host and the tail of the path, never the URL', async () => {
    const admin = await api.member(['org_admin']);
    const id = (await create(admin)).json.endpoint.id as string;
    const reader = await api.member(['read_only']);
    const list = await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, reader);
    expect(list.status).toBe(200);
    expect(list.json.items[0]).toMatchObject({
      id,
      url: null,
      urlMasked: 'hooks.example.com/…c123',
    });
    const one = await api.call('GET', `${BASE}/${id}`, undefined, reader);
    expect(one.json).toMatchObject({ url: null, urlMasked: 'hooks.example.com/…c123' });
    expect(one.text).not.toContain('catch/abc123');
    expect((await api.call('GET', `${BASE}/${id}`, undefined, admin)).json.url).toBe(GOOD.url);
  });

  it('refuses a reader every change, and a member without the capability even a read', async () => {
    const admin = await api.member(['org_admin']);
    const id = (await create(admin)).json.endpoint.id as string;
    const reader = await api.member(['read_only']);
    const calls: [string, string, unknown?][] = [
      ['POST', BASE, { orgId, ...GOOD }],
      ['PATCH', `${BASE}/${id}`, { description: 'x' }],
      ['DELETE', `${BASE}/${id}`],
      ['POST', `${BASE}/${id}/secret`, {}],
      ['POST', `${BASE}/${id}/test`],
      ['POST', `${BASE}/${id}/replay`, { from: 0, to: 1 }],
      ['POST', `${BASE}/${id}/deliveries/e1/replay`],
    ];
    for (const [m, p, b] of calls)
      expect((await api.call(m, p, b, reader)).status, `${m} ${p}`).toBe(403);
    const author = await api.member(['template_author']);
    expect((await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, author)).status).toBe(403);
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(1);
  });

  it('names the org on lists and creates, and masks by-id routes from non-members', async () => {
    const admin = await api.member(['org_admin']);
    const id = (await create(admin)).json.endpoint.id as string;
    const out = await api.outsider();
    expect((await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, out)).status).toBe(403);
    expect((await create(out)).status).toBe(403);
    expect((await api.call('GET', BASE, undefined, admin)).status).toBe(422);
    for (const [m, p, b] of [
      ['GET', `${BASE}/${id}`],
      ['PATCH', `${BASE}/${id}`, { description: 'x' }],
      ['DELETE', `${BASE}/${id}`],
      ['POST', `${BASE}/${id}/secret`, {}],
      ['POST', `${BASE}/${id}/test`],
      ['GET', `${BASE}/${id}/deliveries`],
      ['POST', `${BASE}/${id}/replay`, { from: 0, to: 1 }],
    ] as [string, string, unknown?][])
      expect((await api.call(m, p, b, out)).status, `${m} ${p}`).toBe(404);
  });

  it('keeps the two modes apart: the mode header picks the endpoints', async () => {
    const live = await api.member(['org_admin']);
    const test = await api.member(['org_admin'], { mode: 'test' });
    const liveId = (await create(live)).json.endpoint.id as string;
    const testId = (await create(test)).json.endpoint;
    expect(testId.mode).toBe('test');
    expect(
      (await api.call('GET', `${BASE}?orgId=${orgId}`, undefined, test)).json.items.map(
        (e: { id: string }) => e.id,
      ),
    ).toEqual([testId.id]);
    expect((await api.call('GET', `${BASE}/${liveId}`, undefined, test)).status).toBe(404);
    expect((await api.call('GET', `${BASE}/${testId.id}`, undefined, live)).status).toBe(404);
  });
});

describe('API keys', () => {
  it('accept webhooks:manage, show the full URL, and take the mode from the key', async () => {
    const live = await api.key({ scopes: ['webhooks:manage'] });
    const test = await api.key({ scopes: ['webhooks:manage'], mode: 'test' });
    const made = await api.call('POST', BASE, { ...GOOD, mode: 'live' }, test);
    expect(made.status).toBe(201);
    expect(made.json.endpoint).toMatchObject({ mode: 'test', orgId, url: GOOD.url });
    expect((await api.call('GET', BASE, undefined, live)).json.items).toEqual([]);
    expect((await api.call('GET', BASE, undefined, test)).json.items).toHaveLength(1);
    expect(
      (await api.call('GET', `${BASE}/${made.json.endpoint.id}`, undefined, live)).status,
    ).toBe(404);
    expect((await auditOf(api.rig.db, 'webhook.endpoint.create')).map((r) => r.actor_type)).toEqual(
      ['api_key'],
    );
  });

  it('refuse connections:write, connections:read and passes scopes on the webhook routes', async () => {
    const admin = await api.member(['org_admin']);
    const id = (await create(admin)).json.endpoint.id as string;
    for (const scopes of [
      ['connections:write'],
      ['connections:read'],
      ['passes:read', 'passes:write'],
    ]) {
      const key = await api.key({ scopes });
      for (const [m, p, b] of [
        ['GET', BASE],
        ['POST', BASE, GOOD],
        ['GET', `${BASE}/${id}`],
        ['PATCH', `${BASE}/${id}`, { description: 'x' }],
        ['DELETE', `${BASE}/${id}`],
        ['POST', `${BASE}/${id}/secret`, {}],
        ['POST', `${BASE}/${id}/test`],
        ['POST', `${BASE}/${id}/replay`, { from: 0, to: 1 }],
      ] as [string, string, unknown?][]) {
        const res = await api.call(m, p, b, key);
        await expectProblem(res, 403, 'MISSING_SCOPE');
      }
    }
    expect(await rowCount(api.rig.db, 'webhook_endpoints')).toBe(1);
  });

  it('keep a webhooks:manage key out of /connections', async () => {
    const key = await api.key({ scopes: ['webhooks:manage'] });
    for (const [m, p, b] of [
      ['GET', `/api/v1/connections?orgId=${orgId}`],
      [
        'POST',
        '/api/v1/connections',
        { orgId, connectorType: 'demo', name: 'x', config: { count: 1 } },
      ],
    ] as [string, string, unknown?][])
      await expectProblem(await api.call(m, p, b, key), 403, 'MISSING_SCOPE');
  });

  it('bind an org key to its org; a platform key names one', async () => {
    const other = await api.otherOrg();
    const orgKey = await api.key({ scopes: ['webhooks:manage'] });
    expect((await api.call('POST', BASE, { orgId: other, ...GOOD }, orgKey)).status).toBe(403);
    expect((await api.call('GET', `${BASE}?orgId=${other}`, undefined, orgKey)).status).toBe(403);
    const platform = await api.key({ scopes: ['webhooks:manage'], orgId: null });
    expect((await api.call('GET', BASE, undefined, platform)).status).toBe(422);
    expect((await api.call('POST', BASE, GOOD, platform)).status).toBe(422);
    const made = await api.call('POST', BASE, { orgId, ...GOOD }, platform);
    expect(made.status).toBe(201);
    expect(made.json.endpoint.orgId).toBe(orgId);
    // The platform key reaches an endpoint of the org it has a membership-free authority for, by id.
    expect(
      (await api.call('GET', `${BASE}/${made.json.endpoint.id}`, undefined, platform)).status,
    ).toBe(200);
    expect(
      (await api.call('GET', `${BASE}/${made.json.endpoint.id}`, undefined, orgKey)).status,
    ).toBe(200);
  });

  it('give another org key a 404, and change nothing', async () => {
    const other = await api.otherOrg();
    const orgKey = await api.key({ scopes: ['webhooks:manage'] });
    const id = (await api.call('POST', BASE, GOOD, orgKey)).json.endpoint.id as string;
    const foreign = await api.key({ scopes: ['webhooks:manage'], orgId: other });
    const before = await rowCount(api.rig.db, 'audit_log', "action LIKE 'webhook.%'");
    for (const [m, p, b] of [
      ['GET', `${BASE}/${id}`],
      ['PATCH', `${BASE}/${id}`, { description: 'x' }],
      ['DELETE', `${BASE}/${id}`],
      ['POST', `${BASE}/${id}/secret`, {}],
      ['POST', `${BASE}/${id}/test`],
      ['GET', `${BASE}/${id}/deliveries`],
      ['GET', `${BASE}/${id}/deliveries/e1`],
      ['POST', `${BASE}/${id}/deliveries/e1/replay`],
      ['POST', `${BASE}/${id}/replay`, { from: 0, to: 1 }],
    ] as [string, string, unknown?][])
      expect((await api.call(m, p, b, foreign)).status, `${m} ${p}`).toBe(404);
    expect(await rowCount(api.rig.db, 'audit_log', "action LIKE 'webhook.%'")).toBe(before);
    expect(await rowCount(api.rig.db, 'webhook_endpoint_secrets', 'endpoint_id = ?', [id])).toBe(1);
    expect(net.calls).toEqual([]);
  });
});

describe('the feed scope', () => {
  it('needs passes:read, which a webhooks:manage key lacks', async () => {
    const reader = await api.key({ scopes: ['passes:read'] });
    expect((await api.call('GET', '/api/v1/events', undefined, reader)).status).toBe(200);
    const hooks = await api.key({ scopes: ['webhooks:manage'] });
    await expectProblem(
      await api.call('GET', '/api/v1/events', undefined, hooks),
      403,
      'MISSING_SCOPE',
    );
    const noScope = await api.key({ scopes: ['connections:read'] });
    expect((await api.call('GET', '/api/v1/events', undefined, noScope)).status).toBe(403);
    const platform = await api.key({ scopes: ['passes:read'], orgId: null });
    expect((await api.call('GET', '/api/v1/events', undefined, platform)).status).toBe(422);
    expect(
      (await api.call('GET', `/api/v1/events?orgId=${orgId}`, undefined, platform)).status,
    ).toBe(200);
  });

  it('lets any member with passes:read read it, and refuses non-members', async () => {
    expect(
      (
        await api.call(
          'GET',
          `/api/v1/events?orgId=${orgId}`,
          undefined,
          await api.member(['read_only']),
        )
      ).status,
    ).toBe(200);
    expect(
      (await api.call('GET', `/api/v1/events?orgId=${orgId}`, undefined, await api.outsider()))
        .status,
    ).toBe(403);
    expect((await api.call('GET', '/api/v1/events')).status).toBe(401);
  });
});
