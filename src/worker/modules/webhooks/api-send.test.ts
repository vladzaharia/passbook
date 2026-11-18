import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../../connectors/lib/hmac.ts';
import { all } from '../../platform/db.ts';
import { type Api, BASE, GOOD, rowCount, setupApi, wipe } from './api-test-fixtures.ts';
import { endpointOf, type Net, stubNet } from './deliver-test-fixtures.ts';
import { clearResolverMemo } from './resolver-memo.ts';

let api: Api;
let net: Net;
let orgId: string;
let admin: Record<string, string>;

beforeAll(async () => {
  api = await setupApi();
  net = stubNet();
  orgId = api.rig.orgId;
});
afterAll(() => net.restore());
beforeEach(async () => {
  await wipe(api.rig);
  admin = await api.member(['org_admin']);
  net.calls.length = 0;
  net.dns = {};
  clearResolverMemo();
  net.respond = () => new Response('ok', { status: 200 });
  api.resetLimits();
});

const create = async (url = GOOD.url, headers = admin) =>
  (await api.call('POST', BASE, { orgId, ...GOOD, url }, headers)).json as {
    endpoint: { id: string };
    secret: string;
  };

describe('the test event', () => {
  it('goes to that endpoint only, signed, and describes no pass', async () => {
    const a = await create('https://hooks.example.com/a');
    await create('https://hooks.example.com/b');
    const res = await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, status: 200, errorCode: null });
    expect(net.calls.map((c) => c.url)).toEqual(['https://hooks.example.com/a']);
    const [call] = net.calls;
    const body = JSON.parse(call?.body ?? '{}');
    expect(body).toMatchObject({ type: 'webhook.test', mode: 'live', orgId, pass: null, data: {} });
    expect(call?.headers['x-passbook-event-type']).toBe('webhook.test');
    expect(call?.headers['x-passbook-event-id']).toBe(body.id);
    const sig = await signWebhook(
      a.secret,
      Number(call?.headers['x-passbook-timestamp']),
      call?.body ?? '',
    );
    expect(call?.headers['x-passbook-signature']).toBe(sig);
  });

  it('carries the endpoint mode: a test endpoint gets a test event', async () => {
    const test = await api.member(['org_admin'], { mode: 'test' });
    const t = await create('https://hooks.example.com/t', test);
    expect((await api.call('POST', `${BASE}/${t.endpoint.id}/test`, undefined, test)).json.ok).toBe(
      true,
    );
    expect(JSON.parse(net.calls[0]?.body ?? '{}')).toMatchObject({ mode: 'test', orgId });
    // The live session cannot reach it at all.
    expect((await api.call('POST', `${BASE}/${t.endpoint.id}/test`, undefined, admin)).status).toBe(
      404,
    );
    expect(net.calls).toHaveLength(1);
  });

  it('signs with every live secret during a rotation overlap', async () => {
    const a = await create();
    const rotated = (
      await api.call('POST', `${BASE}/${a.endpoint.id}/secret`, { overlapHours: 24 }, admin)
    ).json.secret;
    await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin);
    const call = net.calls[0];
    const ts = Number(call?.headers['x-passbook-timestamp']);
    const header = call?.headers['x-passbook-signature'] ?? '';
    for (const s of [a.secret, rotated])
      expect(header).toContain(await signWebhook(s, ts, call?.body ?? ''));
  });

  it('reports a failing receiver without touching delivery state or health counters', async () => {
    const a = await create();
    await api.rig.kit.pass();
    const before = {
      deliveries: await rowCount(api.rig.db, 'webhook_deliveries'),
      feed: await rowCount(api.rig.db, 'event_feed'),
    };
    net.respond = () => new Response('no', { status: 500 });
    const bad = await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin);
    expect(bad.json).toMatchObject({ ok: false, status: 500, errorCode: null });
    net.respond = () => {
      throw new Error('boom');
    };
    const down = await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin);
    expect(down.json).toMatchObject({ ok: false, status: null, errorCode: 'UPSTREAM' });
    expect(await endpointOf(api.rig.db, a.endpoint.id)).toMatchObject({
      status: 'active',
      consecutive_failures: 0,
      failing_since: null,
      last_success_at: null,
    });
    expect(await rowCount(api.rig.db, 'webhook_deliveries')).toBe(before.deliveries);
    expect(await rowCount(api.rig.db, 'event_feed')).toBe(before.feed);
    const attempts = await all<{
      trigger: string;
      event_seq: number | null;
      status: number | null;
    }>(
      api.rig.db,
      'SELECT trigger, event_seq, status FROM webhook_attempts WHERE endpoint_id = ? ORDER BY at, id',
      [a.endpoint.id],
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.every((r) => r.trigger === 'test' && r.event_seq === null)).toBe(true);
  });

  it('refuses a host that turned private after save, without sending', async () => {
    const a = await create();
    // The resolver memo holds the public answer from save time for a minute.
    clearResolverMemo();
    net.dns['hooks.example.com'] = ['10.0.0.1'];
    const res = await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin);
    expect(res.json).toMatchObject({ ok: false, status: null });
    expect(res.json.errorCode).toBeTruthy();
    expect(net.calls).toEqual([]);
    net.dns = {};
  });

  it('allows ten a minute per tenant, whichever endpoint, then 429 with nothing sent', async () => {
    const a = await create();
    const b = await create('https://hooks.example.com/b');
    for (let i = 0; i < 10; i++)
      expect(
        (await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin)).status,
      ).toBe(200);
    const sent = net.calls.length;
    for (const id of [a.endpoint.id, b.endpoint.id])
      expect((await api.call('POST', `${BASE}/${id}/test`, undefined, admin)).status).toBe(429);
    // Recreating the endpoint does not reset it.
    await api.call('DELETE', `${BASE}/${a.endpoint.id}`, undefined, admin);
    const again = await create();
    expect(
      (await api.call('POST', `${BASE}/${again.endpoint.id}/test`, undefined, admin)).status,
    ).toBe(429);
    expect(net.calls).toHaveLength(sent);
  });

  it('is a 404 for a deleted endpoint and sends nothing', async () => {
    const a = await create();
    await api.call('DELETE', `${BASE}/${a.endpoint.id}`, undefined, admin);
    expect((await api.call('POST', `${BASE}/${a.endpoint.id}/test`, undefined, admin)).status).toBe(
      404,
    );
    expect(net.calls).toEqual([]);
    expect(await rowCount(api.rig.db, 'webhook_attempts', "trigger = 'test'")).toBe(0);
  });
});
