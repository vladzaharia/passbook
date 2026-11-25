import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import {
  type DeveloperHome,
  DeveloperHomeSchema,
} from '../../../shared/contracts/developer-home.ts';
import { RequestLogPageSchema } from '../../../shared/contracts/index.ts';
import { first, run } from '../../platform/db.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { BROWSER, bearer, fromPage } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

type Dev = Awaited<ReturnType<typeof t.developer>>;
const DAY = 86_400_000;

async function home(headers: Record<string, string>): Promise<DeveloperHome> {
  const res = await t.call('/developer/home', { headers });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return DeveloperHomeSchema.parse(await res.json());
}

const json = (headers: Record<string, string>, method: string, body: unknown) => ({
  method,
  headers: {
    ...headers,
    'content-type': 'application/json',
    'idempotency-key': t.kit.f.ids.token(),
  },
  body: JSON.stringify(body),
});

/** A pass from the sandbox ticket's sample, sent with `headers` (a key, or the page's try token). */
async function makePass(d: Dev, headers: Record<string, string>): Promise<string> {
  const detail = (await (await t.call(`/templates/${d.made.templateId}`, { headers })).json()) as {
    manifest: { sample?: Record<string, unknown> };
  };
  const res = await t.call(
    '/passes',
    json(headers, 'POST', { templateId: d.made.templateId, input: detail.manifest.sample ?? {} }),
  );
  expect(res.status, await res.clone().text()).toBe(201);
  await t.settle();
  return ((await res.json()) as { id: string }).id;
}

async function sendTestEvent(d: Dev, endpointId: string) {
  const res = await t.call(
    `/webhook-endpoints/${endpointId}/test`,
    json(bearer(d.key.secret), 'POST', { type: 'webhook.test' }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  await t.settle();
}

const funnelFirsts = (orgId: string) =>
  first<Record<string, number | null>>(
    t.kit.env.DB,
    `SELECT first_call_at, first_pass_at, first_key_call_at, first_change_at, first_webhook_at
     FROM developer_sandboxes WHERE org_id = ?`,
    [orgId],
  );

describe('GET /developer/home', () => {
  it('needs a developer session: no key, no plain user, no anonymous caller', async () => {
    const d = await t.developer();
    await expectProblem(await t.call('/developer/home'), 401, 'UNAUTHENTICATED');
    await expectProblem(
      await t.call('/developer/home', { headers: bearer(d.key.secret) }),
      401,
      'UNAUTHENTICATED',
    );
    const plain = await makeSession(t.kit.f, { userId: (await makeUser(t.kit.f)).id });
    await expectProblem(
      await t.call('/developer/home', { headers: { ...plain.headers, ...BROWSER } }),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
  });

  it('with no sandbox: state none, and the orgs a Live key can come from', async () => {
    const user = await makeUser(t.kit.f);
    const org = await makeOrg(t.kit.f, { name: 'Real Co' });
    const now = t.kit.clock.now();
    const invitation = t.kit.f.ids.id();
    await run(
      t.kit.env.DB,
      `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, '["org_admin"]', ?, ?, ?, ?)`,
      [invitation, org.id, user.primaryEmail, t.kit.f.ids.token(), now, now + 3600_000, now],
    );
    await run(
      t.kit.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
      [t.kit.f.ids.id(), org.id, user.id, invitation, now],
    );
    const session = await makeSession(t.kit.f, { userId: user.id, roles: ['user', 'developer'] });
    const h = await home({ ...session.headers, ...BROWSER });
    expect(h).toMatchObject({
      now,
      state: 'none',
      sandbox: null,
      progress: null,
      usage: null,
      keys: [],
      calls: [],
      endpoints: [],
      passes: [],
    });
    expect(h.liveOrgs).toEqual([
      { orgId: org.id, name: 'Real Co', slug: org.slug, roles: ['org_admin'], canMintLive: true },
    ]);
  });

  it('fresh: the sandbox step done, its key and capture endpoint, nothing used yet', async () => {
    const d = await t.developer();
    const h = await home(d.browser);
    expect(h.state).toBe('open');
    expect(h.sandbox).toMatchObject({
      orgId: d.made.orgId,
      templateId: d.made.templateId,
      mode: 'test',
      closedAt: null,
      reopenUntil: null,
      limits: { passes: 500, templates: 10, endpoints: 3, keys: 3 },
    });
    expect(h.progress).toMatchObject({
      sandboxAt: d.made.createdAt,
      restartedAt: null,
      keyCallAt: null,
      passAt: null,
      doneAt: null,
      next: 'call',
    });
    expect(h.keys).toHaveLength(1);
    expect(h.keys[0]).toMatchObject({ id: d.key.id, sandboxKey: true, retireAt: null });
    expect(d.key.secret.startsWith(`${h.keys[0]?.secretPrefix}_`)).toBe(true);
    expect(JSON.stringify(h)).not.toContain(d.key.secret);
    expect(h.endpoints).toEqual([
      expect.objectContaining({ target: 'capture', url: null, lastAt: null, lastOk: null }),
    ]);
    expect(h.usage).toMatchObject({ calls24h: 0, errors24h: 0, captures24h: 0, passes: 0 });
    expect(h.usage?.series.calls).toHaveLength(24);
    expect(h.liveOrgs.map((o) => o.orgId)).not.toContain(d.made.orgId);
  });

  it('progressed: Run here makes the pass, a key call below 400 ticks the terminal, then change and webhook finish', async () => {
    const d = await t.developer();
    await t.call('/passes/none', { headers: bearer(d.key.secret) });
    await t.settle();
    t.kit.clock.advance(5000);
    const { token } = await t.mint(d.browser);
    const passId = await makePass(d, fromPage(d.browser, token));
    let h = await home(d.browser);
    // A 404 and a try-token call are not "your terminal".
    expect(h.progress).toMatchObject({ keyCallAt: null, next: 'change' });
    expect(h.progress?.passAt).toBe(t.kit.clock.now());

    t.kit.clock.advance(5000);
    await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.settle();
    t.kit.clock.advance(5000);
    const patched = await t.call(
      `/passes/${passId}`,
      json(bearer(d.key.secret), 'PATCH', { input: { admission: 'VIP' } }),
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    await t.settle();
    h = await home(d.browser);
    expect(h.progress?.keyCallAt).toBe(t.kit.clock.now() - 5000);
    expect(h.progress).toMatchObject({ changeAt: t.kit.clock.now(), next: 'webhook' });

    t.kit.clock.advance(5000);
    const capture = h.endpoints[0]?.id ?? '';
    await sendTestEvent(d, capture);
    h = await home(d.browser);
    const p = h.progress;
    expect(p?.webhookAt).toBe(t.kit.clock.now());
    expect(p?.next).toBeNull();
    expect(p?.doneAt).toBe(p?.webhookAt);
    expect(p?.doneMs).toBe((p?.doneAt ?? 0) - (p?.startedAt ?? 0));
    expect(h.endpoints[0]).toMatchObject({ id: capture, lastAt: t.kit.clock.now(), lastOk: true });
    expect(h.usage).toMatchObject({ passes: 1, captures24h: 1 });
    expect(h.usage?.errors24h).toBe(1);
    expect(h.usage?.calls24h).toBe(h.usage?.series.calls.reduce((a, b) => a + b, 0));
    expect(h.passes).toEqual([
      expect.objectContaining({ id: passId, version: 2, previewUrl: expect.stringContaining('/') }),
    ]);
    expect(h.calls.length).toBeGreaterThanOrEqual(4);
    expect(h.calls[0]?.at).toBeGreaterThanOrEqual(h.calls.at(-1)?.at ?? 0);
    const firsts = await funnelFirsts(d.made.orgId);
    expect(firsts).toMatchObject({
      first_key_call_at: p?.keyCallAt,
      first_change_at: p?.changeAt,
      first_webhook_at: p?.webhookAt,
    });
  });

  it('after a reset: the track restarts from the reset, the funnel keeps its first values', async () => {
    const d = await t.developer();
    const passId = await makePass(d, bearer(d.key.secret));
    await t.call(
      `/passes/${passId}`,
      json(bearer(d.key.secret), 'PATCH', { input: { admission: 'VIP' } }),
    );
    await t.settle();
    const before = await funnelFirsts(d.made.orgId);
    expect(before?.first_key_call_at).not.toBeNull();
    t.kit.clock.advance(60_000);
    const resetAt = t.kit.clock.now();
    // What D9's reset writes, beside its purge.
    await run(
      t.kit.env.DB,
      `UPDATE developer_sandboxes SET track_started_at = ?, track_key_call_at = NULL, track_pass_at = NULL,
         track_change_at = NULL, track_webhook_at = NULL WHERE org_id = ?`,
      [resetAt, d.made.orgId],
    );
    let h = await home(d.browser);
    expect(h.progress).toMatchObject({
      startedAt: resetAt,
      restartedAt: resetAt,
      sandboxAt: resetAt,
      keyCallAt: null,
      passAt: null,
      changeAt: null,
      doneAt: null,
      next: 'call',
    });
    t.kit.clock.advance(1000);
    await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.settle();
    h = await home(d.browser);
    expect(h.progress?.keyCallAt).toBe(t.kit.clock.now());
    expect(await funnelFirsts(d.made.orgId)).toEqual(before);
  });

  it('closed: read-only, keys revoked, reopenable until the export window ends', async () => {
    const d = await t.developer();
    const res = await t.call('/developer/sandbox/close', { method: 'POST', headers: d.browser });
    expect(res.status, await res.clone().text()).toBe(200);
    const h = await home(d.browser);
    expect(h.state).toBe('closed');
    expect(h.sandbox?.closedAt).toBe(t.kit.clock.now());
    expect(h.sandbox?.closeReason).toBe('user');
    expect(h.sandbox?.reopenUntil).toBe(t.kit.clock.now() + 30 * DAY);
    expect(h.keys).toEqual([]);
  });

  it('authority: another developer’s sandbox, keys, calls, passes and endpoints never appear', async () => {
    const a = await t.developer();
    const b = await t.developer();
    for (const d of [a, b]) await makePass(d, bearer(d.key.secret));
    const ha = await home(a.browser);
    const hb = await home(b.browser);
    const ids = (h: DeveloperHome) => [
      h.sandbox?.id,
      h.sandbox?.orgId,
      ...h.keys.map((k) => k.id),
      ...h.calls.map((c) => c.id),
      ...h.passes.map((p) => p.id),
      ...h.endpoints.map((e) => e.id),
    ];
    const textA = JSON.stringify(ha);
    const textB = JSON.stringify(hb);
    for (const id of ids(hb)) expect(textA).not.toContain(id);
    for (const id of ids(ha)) expect(textB).not.toContain(id);
    expect(new Set(ha.calls.map((c) => c.keyId))).toEqual(new Set([a.key.id]));
    // An org or user id in the query is not read.
    const asked = await t.call(`/developer/home?orgId=${b.made.orgId}&userId=${b.user.id}`, {
      headers: a.browser,
    });
    expect(JSON.stringify(await asked.json())).not.toContain(b.made.orgId);
  });
});

describe('developer track triggers', () => {
  it('sets a step once per start, and a restart moves forward and clears every step', async () => {
    const d = await t.developer();
    await makePass(d, bearer(d.key.secret));
    const db = t.kit.env.DB;
    const org = d.made.orgId;
    const set = (sql: string, ...params: (number | null)[]) =>
      run(db, `UPDATE developer_sandboxes SET ${sql} WHERE org_id = ?`, [...params, org]);
    await expect(set('track_pass_at = NULL')).rejects.toThrow(/set once per start/);
    await expect(set('first_key_call_at = 1')).rejects.toThrow(/set once/);
    await expect(set('track_started_at = ?', 1)).rejects.toThrow(/moves forward/);
    const later = t.kit.clock.now() + 1;
    await expect(set('track_started_at = ?', later)).rejects.toThrow(/clears every step/);
    await set(
      'track_started_at = ?, track_key_call_at = NULL, track_pass_at = NULL, track_change_at = NULL, track_webhook_at = NULL',
      later,
    );
    await expect(set('track_started_at = NULL')).rejects.toThrow(/moves forward/);
  });
});

describe('GET /developer/home calls', () => {
  it('leaves out the portal’s own reads and keeps the calls a person made', async () => {
    const d = await t.developer();
    const { token } = await t.mint(d.browser);
    const page = fromPage(d.browser, token);
    await t.call('/passes', { headers: { ...page, 'x-passbook-client': 'portal' } });
    await t.call('/passes/none', { headers: bearer(d.key.secret) });
    await t.call('/passes', { headers: page });
    await t.settle();
    const h = await home(d.browser);
    expect(h.calls.map((c) => c.status).sort()).toEqual([200, 404]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls.some((c) => c.client === 'portal')).toBe(false);
  });
});

describe('GET /developer/logs source and after', () => {
  it('splits key calls from Run here and lists only rows after the cursor', async () => {
    const d = await t.developer();
    const { token } = await t.mint(d.browser);
    await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.call('/passes', { headers: fromPage(d.browser, token) });
    await t.settle();
    const list = async (q: string) =>
      RequestLogPageSchema.parse(
        await (await t.call(`/developer/logs${q}`, { headers: d.browser })).json(),
      ).items;
    expect((await list('?source=key')).map((i) => i.via)).toEqual([null]);
    expect((await list('?source=try')).map((i) => i.via)).toEqual(['try']);
    const all = await list('');
    expect(all).toHaveLength(2);
    const cursor = all[0]?.id ?? '';
    expect(await list(`?after=${cursor}`)).toEqual([]);
    t.kit.clock.advance(1000);
    await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.settle();
    const fresh = await list(`?source=key&after=${cursor}&keyId=${d.key.id}`);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.at).toBe(t.kit.clock.now());
  });
});
