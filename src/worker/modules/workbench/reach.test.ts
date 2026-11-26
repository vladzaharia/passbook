import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { first } from '../../platform/db.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const day = 86_400_000;

/** A key the member makes in admin with their session (mode from the header). */
async function adminKey(m: Awaited<ReturnType<typeof t.member>>, mode: 'live' | 'test') {
  const res = await t.call(
    'POST',
    '/api-keys',
    { ...m.browser, 'x-passbook-mode': mode },
    {
      orgId: m.orgId,
      name: `Admin ${mode}`,
      kind: 'personal',
      mode,
      scopes: ['passes:read'],
      expiresAt: t.kit.clock.now() + 30 * day,
    },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string; mode: string };
}

describe('L4: keys under a token are Test keys', () => {
  it('create forces Test and refuses Live; the list has no Live key; a Live key id is not found', async () => {
    const m = await t.member();
    const live = await adminKey(m, 'live');
    const { token } = await t.wbMint(m.browser, m.orgId);
    const body = {
      orgId: m.orgId,
      name: 'CI',
      kind: 'personal',
      scopes: ['passes:read'],
      expiresAt: t.kit.clock.now() + 30 * day,
    };
    await expectProblem(
      await t.call('POST', '/api-keys', t.asClient(token), { ...body, mode: 'live' }),
      403,
      'WORKBENCH_TEST_ONLY',
    );
    const made = await t.call('POST', '/api-keys', t.asClient(token), body);
    expect(made.status, await made.clone().text()).toBe(201);
    const key = (await made.json()) as { id: string; mode: string; secret: string };
    expect(key.mode).toBe('test');
    expect(key.secret).toMatch(/^pbp_test_/);

    const list = await t.call('GET', `/api-keys?orgId=${m.orgId}`, t.asClient(token));
    expect(list.status, await list.clone().text()).toBe(200);
    const items = ((await list.json()) as { items: { id: string; mode: string }[] }).items;
    expect(items.map((k) => k.id)).toContain(key.id);
    expect(items.every((k) => k.mode === 'test')).toBe(true);
    // Admin, in its session, still lists both.
    const admin = await t.call('GET', `/api-keys?orgId=${m.orgId}`, m.browser);
    expect(((await admin.json()) as { items: { id: string }[] }).items.map((k) => k.id)).toContain(
      live.id,
    );

    for (const [method, path, payload] of [
      ['GET', `/api-keys/${live.id}?orgId=${m.orgId}`, undefined],
      ['GET', `/api-keys/${live.id}/activity?orgId=${m.orgId}`, undefined],
      ['DELETE', `/api-keys/${live.id}?orgId=${m.orgId}`, undefined],
      ['POST', `/api-keys/${live.id}/rotate`, { orgId: m.orgId, overlapHours: 1 }],
      [
        'POST',
        `/api-keys/${live.id}/retire`,
        { orgId: m.orgId, retireAt: t.kit.clock.now() + day },
      ],
    ] as const)
      await expectProblem(
        await t.call(method, path, t.asClient(token), payload),
        404,
        'API_KEY_NOT_FOUND',
      );
    const own = await t.call('GET', `/api-keys/${key.id}?orgId=${m.orgId}`, t.asClient(token));
    expect(own.status, await own.clone().text()).toBe(200);
  });
});

describe('a token is never a platform admin', () => {
  it("a platform admin's member token cannot reach platform-wide keys or other orgs", async () => {
    const m = await t.member(['org_admin'], ['admin', 'user']);
    const { token } = await t.wbMint(m.browser, m.orgId);
    const client = t.asClient(token);
    expect((await t.call('GET', '/api-keys?orgId=null', client)).status).toBe(404);
    const platform = await t.call('POST', '/api-keys', client, {
      orgId: null,
      name: 'Platform',
      scopes: ['passes:read'],
      expiresAt: t.kit.clock.now() + 30 * day,
    });
    expect([403, 404]).toContain(platform.status);
    const other = await t.member();
    expect((await t.call('GET', `/passes?orgId=${other.orgId}`, client)).status).toBe(404);
    // The console group an admin holds by role still counts.
    t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'true';
    try {
      expect((await t.call('GET', '/passes', client)).status).toBe(200);
    } finally {
      t.kit.env.OIDC_CONSOLE_GROUP_REQUIRED = 'false';
    }
  });
});

describe('L17: the mounted wizard on a member token', () => {
  it('creates, pauses and deletes a Test endpoint; a Live endpoint id is not found', async () => {
    const m = await t.member();
    const live = await t.call(
      'POST',
      '/webhook-endpoints',
      { ...m.browser, 'x-passbook-mode': 'live' },
      { orgId: m.orgId, url: 'https://example.com/live', eventTypes: ['pass.issued'] },
    );
    expect(live.status, await live.clone().text()).toBe(201);
    const liveId = ((await live.json()) as { endpoint: { id: string } }).endpoint.id;

    const { token } = await t.wbMint(m.browser, m.orgId);
    const client = t.asClient(token);
    const hook = { url: 'https://example.com/hook', eventTypes: ['pass.issued'] };
    const dry = await t.call('POST', '/webhook-endpoints?validate=1', client, hook);
    expect(dry.status, await dry.clone().text()).toBe(200);
    const made = await t.call('POST', '/webhook-endpoints', client, hook);
    expect(made.status, await made.clone().text()).toBe(201);
    const { endpoint } = (await made.json()) as { endpoint: { id: string } };
    const row = await first<{ mode: string }>(
      t.kit.env.DB,
      'SELECT mode FROM webhook_endpoints WHERE id = ?',
      [endpoint.id],
    );
    expect(row?.mode).toBe('test');
    const paused = await t.call('PATCH', `/webhook-endpoints/${endpoint.id}`, client, {
      status: 'paused',
    });
    expect(paused.status, await paused.clone().text()).toBe(200);
    expect(await paused.json()).toMatchObject({ status: 'paused' });

    for (const [method, path, payload] of [
      ['GET', `/webhook-endpoints/${liveId}`, undefined],
      ['PATCH', `/webhook-endpoints/${liveId}`, { status: 'paused' }],
      ['DELETE', `/webhook-endpoints/${liveId}`, undefined],
      ['POST', `/webhook-endpoints/${liveId}/secret`, {}],
      ['GET', `/webhook-endpoints/${liveId}/deliveries`, undefined],
    ] as const)
      expect((await t.call(method, path, client, payload)).status, `${method} ${path}`).toBe(404);
    const listed = await t.call('GET', '/webhook-endpoints', client);
    const ids = ((await listed.json()) as { items: { id: string }[] }).items.map((e) => e.id);
    expect(ids).toEqual([endpoint.id]);

    expect((await t.call('DELETE', `/webhook-endpoints/${endpoint.id}`, client)).status).toBe(200);
    // Live is untouched.
    const still = await t.call('GET', `/webhook-endpoints/${liveId}`, {
      ...m.browser,
      'x-passbook-mode': 'live',
    });
    expect(still.status).toBe(200);
  });

  it('a step-up route asks what the session would', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    t.kit.clock.advance(11 * 60_000);
    await expectProblem(
      await t.call('POST', '/webhook-endpoints', t.asClient(token), {
        url: 'https://example.com/late',
        eventTypes: ['pass.issued'],
      }),
      403,
      'STEP_UP_REQUIRED',
    );
  });
});
