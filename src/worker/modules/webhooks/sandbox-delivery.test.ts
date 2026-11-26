import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/count-d1.ts';
import { fakeRateLimiter } from '../../../../test/helpers/fakes.ts';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { type Api, BASE, setupApi } from './api-test-fixtures.ts';
import { sendAllowed } from './deliver-gate.ts';
import {
  deliveryOf,
  drain,
  endpointWithSecret,
  type Net,
  reset,
  stubNet,
} from './deliver-test-fixtures.ts';
import { dispatchLane } from './dispatch.ts';
import { getEndpoint } from './repo-endpoints.ts';

let api: Api;
let net: Net;
let orgId: string;
let admin: Record<string, string>;
let n = 0;

beforeAll(async () => {
  api = await setupApi();
  orgId = (await makeOrg(api.rig.kit.fx, { kind: 'developer' })).id;
  admin = await api.member(['org_admin'], { orgId, mode: 'test' });
});
beforeEach(async () => {
  net = stubNet();
  await reset(api.rig);
  api.resetLimits();
  Object.assign(api.rig.kit.env, { RL_SANDBOX_DELIVERY: fakeRateLimiter({ limit: 60 }) });
});
afterEach(() => net.restore());

const create = (url: string) =>
  api.call('POST', BASE, { orgId, url, eventTypes: ['pass.issued'] }, admin);

/** A Test endpoint, then one issued pass for it: the delivery is due. */
async function due(url: string, org = orgId) {
  const ep = await endpointWithSecret(api.rig, {
    orgId: org,
    mode: 'test',
    url,
    eventTypes: ['pass.issued'],
  });
  await api.rig.kit.pass({ orgId: org, mode: 'test' });
  return { ep, org };
}

async function deliver({ ep, org }: { ep: string; org: string }) {
  await dispatchLane(api.rig.ctx, { endpointId: ep, orgId: org, mode: 'test' });
  await drain(api.rig);
  return deliveryOf(api.rig.db, ep);
}

describe('sandbox endpoint quota', () => {
  it('answers 409 SANDBOX_ENDPOINT_LIMIT at 3 endpoints, the capture endpoint included', async () => {
    await run(
      api.rig.db,
      `INSERT INTO webhook_endpoints (id, org_id, mode, url, event_types, api_version, target, created_at, updated_at)
       VALUES ('cap-1', ?, 'test', 'https://capture.invalid/', '["pass.issued"]', '2026-11-20', 'capture', 1, 1)`,
      [orgId],
    );
    expect((await create('https://hooks.example.com/1')).status).toBe(201);
    expect((await create('https://hooks.example.com/2')).status).toBe(201);
    const refused = await create(`https://hooks.example.com/${++n}`);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({
      code: 'SANDBOX_ENDPOINT_LIMIT',
      feature: 'webhooks.endpoints',
      limit: 3,
      used: 3,
    });
  });

  it('a standard org keeps FEATURE_LIMIT_REACHED', async () => {
    const other = (await makeOrg(api.rig.kit.fx)).id;
    await run(
      api.rig.db,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'webhooks.endpoints', '0', 1)`,
      [other],
    );
    const key = await api.member(['org_admin'], { orgId: other, mode: 'test' });
    const res = await api.call(
      'POST',
      BASE,
      { orgId: other, url: 'https://hooks.example.com/x', eventTypes: ['pass.issued'] },
      key,
    );
    expect([res.status, res.json.code]).toEqual([403, 'FEATURE_LIMIT_REACHED']);
  });
});

describe('sandbox endpoint URLs are refused at save', () => {
  it.each([
    ['http', 'http://hooks.example.com/a'],
    ['a loopback literal', 'https://127.0.0.1/a'],
    ['localhost', 'https://localhost/a'],
    ['a private literal', 'https://10.0.0.5/a'],
    ['the metadata address', 'https://169.254.169.254/latest/meta-data'],
    ['an IPv6 loopback', 'https://[::1]/a'],
    ['a link-local IPv6 literal', 'https://[fe80::1]/a'],
    ['a decimal IP', 'https://2130706433/a'],
    ['credentials in the URL', 'https://user:pw@hooks.example.com/a'],
    ['a non-standard port', 'https://hooks.example.com:8443/a'],
  ])('%s', async (_name, url) => {
    const res = await create(url);
    expect(res.status, res.text).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(net.calls).toEqual([]);
  });

  it('a host that resolves to a private address', async () => {
    net.dns['internal.example.com'] = ['192.168.1.9'];
    const res = await create('https://internal.example.com/a');
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('UNSAFE_URL');
  });

  it('a host that resolves to the metadata address', async () => {
    net.dns['meta.example.com'] = ['169.254.169.254'];
    const res = await create('https://meta.example.com/a');
    expect(res.json.code).toBe('UNSAFE_URL');
  });
});

describe('sandbox delivery', () => {
  it('POSTs the signed event to the URL', async () => {
    const d = await due('https://hooks.example.com/ok');
    expect(await deliver(d)).toMatchObject({ state: 'delivered', last_status: 200 });
    expect(net.calls).toHaveLength(1);
    const [call] = net.calls;
    expect(call?.url).toBe('https://hooks.example.com/ok');
    expect(Object.keys(call?.headers ?? {}).join()).toMatch(/signature/i);
  });

  it('refuses a redirect to a private address and makes no second request', async () => {
    net.respond = () =>
      new Response('', { status: 302, headers: { location: 'https://169.254.169.254/' } });
    const d = await due('https://hooks.example.com/redir');
    expect(await deliver(d)).toMatchObject({ last_error: 'REDIRECT_BLOCKED', last_status: null });
    expect(net.calls).toHaveLength(1);
  });

  it('refuses a host that resolves to a private address at send time', async () => {
    const d = await due('https://rebind.example.com/a');
    net.dns['rebind.example.com'] = ['127.0.0.1'];
    expect(await deliver(d)).toMatchObject({ last_error: 'UNSAFE_URL' });
    expect(net.calls).toEqual([]);
  });

  it('refuses a host that resolves to the metadata address at send time', async () => {
    const d = await due('https://meta2.example.com/a');
    net.dns['meta2.example.com'] = ['169.254.169.254'];
    expect(await deliver(d)).toMatchObject({ last_error: 'UNSAFE_URL' });
    expect(net.calls).toEqual([]);
  });

  it('waits, unsent and uncharged, past 60 a minute for the sandbox', async () => {
    Object.assign(api.rig.kit.env, { RL_SANDBOX_DELIVERY: fakeRateLimiter({ limit: 0 }) });
    const d = await due('https://hooks.example.com/limited');
    expect(await deliver(d)).toMatchObject({
      state: 'pending',
      attempts: 0,
      last_error: 'RATE_LIMITED',
    });
    expect(net.calls).toEqual([]);
  });

  it('a standard org in Test does not draw on the sandbox limit', async () => {
    Object.assign(api.rig.kit.env, { RL_SANDBOX_DELIVERY: fakeRateLimiter({ limit: 0 }) });
    const d = await due('https://hooks.example.com/standard', api.rig.orgId);
    expect(await deliver(d)).toMatchObject({ state: 'delivered' });
  });
});

describe('the send gate', () => {
  it('reads the org kind from the due delivery: a send costs no query of its own', async () => {
    const d = await due('https://hooks.example.com/count');
    const endpoint = await getEndpoint(api.rig.db, { orgId, mode: 'test' }, d.ep);
    if (!endpoint) throw new Error('setup');
    const counted = countD1(api.rig.db);
    const gate = (sandbox: boolean) => {
      const env = { ...api.rig.ctx.env, DB: counted.db, ...limiters };
      return sendAllowed({ ...api.rig.ctx, env }, endpoint, sandbox);
    };
    let limiters = { RL_SANDBOX_DELIVERY: fakeRateLimiter({ limit: 60 }) };
    expect(await gate(true)).toBe(true);
    limiters = { RL_SANDBOX_DELIVERY: fakeRateLimiter({ limit: 0 }) };
    expect(await gate(true)).toBe(false);
    expect(await gate(false)).toBe(true);
    expect(counted.count()).toBe(0);
  });
});
