import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { resetDeps } from './deps.ts';
import { BASE, probeApp, reply, upstream } from './probe-fixtures.ts';
import * as service from './service.ts';

let t: Awaited<ReturnType<typeof probeApp>>;
beforeEach(async () => {
  t = await probeApp();
});
afterEach(() => resetDeps());

const ids = (...v: string[]) => v.map((id) => ({ id }));
const list = { path: '/m', recordsPointer: '/data' };

describe('planted credentials never come back', () => {
  const cases: {
    name: string;
    auth: Record<string, unknown>;
    secrets: Record<string, string>;
    leaks: string[];
  }[] = [
    {
      name: 'bearer token',
      auth: { type: 'bearer' },
      secrets: { token: 'tok-PLANTED-xyz' },
      leaks: ['tok-PLANTED-xyz', btoa('tok-PLANTED-xyz')],
    },
    {
      name: 'basic username and password',
      auth: { type: 'basic' },
      secrets: { username: 'svc-user', password: 'pw-PLANTED-9' },
      leaks: ['pw-PLANTED-9', btoa('svc-user:pw-PLANTED-9')],
    },
    {
      name: 'header value',
      auth: { type: 'header', headerName: 'X-Api-Key' },
      secrets: { headerValue: 'hv-PLANTED-5' },
      leaks: ['hv-PLANTED-5'],
    },
    {
      name: 'query value',
      auth: { type: 'query', queryParam: 'api_key' },
      secrets: { queryValue: 'qv+PLANTED/77=' },
      leaks: ['qv+PLANTED/77=', encodeURIComponent('qv+PLANTED/77=')],
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const [primary = ''] = c.leaks;
      const echo = (v: string) => `Bearer ${v} Basic ${v} ?api_key=${v}`;
      upstream((url, headers) =>
        reply(
          200,
          {
            data: [{ id: 'a', note: c.leaks.map(echo).join(' '), [primary]: 'as a key' }],
            seen: Object.fromEntries(headers),
            links: { next: `/v1/m?page=2&api_key=${c.leaks[1] ?? primary}` },
            url: url.toString(),
          },
          {
            'x-ratelimit-echo': c.leaks.join(' '),
            link: `<${BASE}/m?api_key=${c.leaks.at(-1)}>; rel="next"`,
          },
        ),
      );
      const out = await t.probe(
        {
          auth: c.auth,
          list: { ...list, pagination: { style: 'next-link', nextPointer: '/links/next' } },
        },
        { secrets: c.secrets },
      );
      expect(out.status).toBe(200);
      expect(out.json.ok).toBe(true);
      const text = JSON.stringify(out.json);
      for (const leak of [...c.leaks, ...Object.values(c.secrets)])
        expect(text).not.toContain(leak);
      expect(text).toContain('***');
      expect(out.json.request.url).not.toMatch(/PLANTED/);
      // The next-page token carries no credential either, in any encoding.
      const token = atob(
        String(out.json.page.next).slice(3).replaceAll('-', '+').replaceAll('_', '/'),
      );
      for (const leak of c.leaks) expect(token).not.toContain(leak);
    });
  }

  it('a saved probe masks the stored secret and sends it once', async () => {
    const calls = upstream(() => ({ data: [{ id: 'a', echo: 'stored-tok-PLANTED' }] }));
    const conn = await service.create(t.kit.sctx, t.kit.actor, {
      orgId: t.kit.org.id,
      connectorType: 'http-json',
      name: 'REST',
      mode: 'poll',
      config: { baseUrl: BASE, auth: { type: 'bearer' }, list },
      secrets: { token: 'stored-tok-PLANTED' },
    } as never);
    const out = await t.call(`/api/v1/connections/${conn.id}/probe`, { target: 'list' });
    expect(out.json.ok).toBe(true);
    expect(JSON.stringify(out.json)).not.toContain('stored-tok-PLANTED');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer stored-tok-PLANTED');
  });

  it('stores nothing and logs no body: the unsaved probe leaves no connection or credential', async () => {
    upstream(() => ({ data: ids('a') }));
    await t.probe({ auth: { type: 'bearer' }, list }, { secrets: { token: 'unsaved-tok' } });
    expect(
      await all(t.kit.env.DB, 'SELECT id FROM connections WHERE org_id = ?', [t.kit.org.id]),
    ).toEqual([]);
    expect(
      await all(t.kit.env.DB, 'SELECT id FROM credentials WHERE org_id = ?', [t.kit.org.id]),
    ).toEqual([]);
  });
});

describe('who may probe, and how often', () => {
  const input = () => ({
    orgId: t.kit.org.id,
    connectorType: 'http-json',
    config: { baseUrl: BASE, list },
    target: 'list',
  });

  it('needs connections:write for a key and an org it belongs to', async () => {
    const calls = upstream(() => ({ data: ids('a') }));
    const read = await makeApiKey(t.kit, { orgId: t.kit.org.id, scopes: ['connections:read'] });
    const write = await makeApiKey(t.kit, { orgId: t.kit.org.id, scopes: ['connections:write'] });
    const other = await makeOrg(t.kit);
    const denied = await t.call('/api/v1/connections/probe', input(), read.headers);
    expect(denied).toMatchObject({ status: 403, json: { code: 'MISSING_SCOPE' } });
    const elsewhere = await t.call(
      '/api/v1/connections/probe',
      { ...input(), orgId: other.id },
      write.headers,
    );
    expect(elsewhere.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect((await t.call('/api/v1/connections/probe', input(), write.headers)).json.ok).toBe(true);
  });

  it('refuses a caller with no session or key', async () => {
    upstream(() => ({}));
    const res = await t.app.request(
      '/api/v1/connections/probe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input()),
      },
      t.kit.env,
    );
    expect(res.status).toBe(401);
  });

  it('a saved connection of another org reads as missing', async () => {
    upstream(() => ({}));
    const other = await makeOrg(t.kit);
    const conn = await service.create(t.kit.sctx, t.kit.actor, {
      orgId: other.id,
      connectorType: 'http-json',
      name: 'REST',
      mode: 'poll',
      config: { baseUrl: BASE, list },
    } as never);
    const out = await t.call(`/api/v1/connections/${conn.id}/probe`, { target: 'list' });
    expect(out.status).toBe(404);
  });

  it('allows 10 a minute per caller, then 429 with when to retry', async () => {
    const calls = upstream(() => ({ data: ids('a') }));
    for (let i = 0; i < 10; i++)
      expect((await t.call('/api/v1/connections/probe', input())).status).toBe(200);
    const limited = await t.call('/api/v1/connections/probe', input());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls).toHaveLength(10);
    t.kit.clock.advance(60_000);
    expect((await t.call('/api/v1/connections/probe', input())).status).toBe(200);
  });

  it('allows 60 an hour per org across callers', async () => {
    const calls = upstream(() => ({ data: ids('a') }));
    const hour = Math.floor(t.kit.clock.now() / 3_600_000) * 3_600_000;
    await run(t.kit.env.DB, 'INSERT INTO counters (key, window_start, count) VALUES (?, ?, 60)', [
      `connection-probe:org:${t.kit.org.id}`,
      hour,
    ]);
    const limited = await t.call('/api/v1/connections/probe', input());
    expect(limited.status).toBe(429);
    expect(calls).toHaveLength(0);
  });

  it('is not available in Test mode', async () => {
    upstream(() => ({}));
    const out = await t.call('/api/v1/connections/probe', input(), {
      ...t.session.headers,
      'x-passbook-mode': 'test',
    });
    expect([404, 403]).toContain(out.status);
  });
});

describe('a saved probe', () => {
  async function saved(secrets?: Record<string, string>) {
    return service.create(t.kit.sctx, t.kit.actor, {
      orgId: t.kit.org.id,
      connectorType: 'http-json',
      name: 'REST',
      mode: 'poll',
      config: { baseUrl: BASE, auth: { type: 'bearer' }, list },
      ...(secrets ? { secrets } : {}),
    } as never);
  }

  it('uses a config override with the stored secret on the same host', async () => {
    const calls = upstream(() => ({ items: ids('a') }));
    const conn = await saved({ token: 'tok-1' });
    const out = await t.call(`/api/v1/connections/${conn.id}/probe`, {
      target: 'list',
      config: {
        baseUrl: BASE,
        auth: { type: 'bearer' },
        list: { path: '/other', recordsPointer: '/items' },
      },
    });
    expect(out.json.ok).toBe(true);
    expect(calls[0]?.url).toBe(`${BASE}/other`);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('never sends the stored secret to a new host', async () => {
    const calls = upstream(() => ({ data: ids('a') }));
    const conn = await saved({ token: 'tok-1' });
    const out = await t.call(`/api/v1/connections/${conn.id}/probe`, {
      target: 'list',
      config: { baseUrl: 'https://elsewhere.example.com/v1', auth: { type: 'bearer' }, list },
    });
    expect(out.status).toBe(422);
    expect(calls).toHaveLength(0);
    const fresh = await t.call(`/api/v1/connections/${conn.id}/probe`, {
      target: 'list',
      config: { baseUrl: 'https://elsewhere.example.com/v1', auth: { type: 'bearer' }, list },
      secrets: { token: 'tok-2' },
    });
    expect(fresh.json.ok).toBe(true);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok-2');
  });

  it('refuses a connection that is not a REST API', async () => {
    upstream(() => ({}));
    const demo = await service.create(t.kit.sctx, t.kit.actor, {
      orgId: t.kit.org.id,
      connectorType: 'demo',
      name: 'Demo',
      mode: 'poll',
      config: { count: 2 },
    } as never);
    const out = await t.call(`/api/v1/connections/${demo.id}/probe`, { target: 'list' });
    expect(out).toMatchObject({ status: 422, json: { code: 'VALIDATION' } });
  });
});

describe('the audit entry', () => {
  it('names the host, the status and the outcome, nothing else', async () => {
    upstream(() => ({ data: [{ id: 'a', email: 'person@example.com' }] }));
    await t.probe({ auth: { type: 'bearer' }, list }, { secrets: { token: 'audit-tok' } });
    upstream(() => reply(401, 'no'));
    await t.probe({ list });
    const rows = await all<{ action: string; detail: string }>(
      t.kit.env.DB,
      "SELECT action, detail FROM audit_log WHERE org_id = ? AND action = 'connection.probe' ORDER BY at, rowid",
      [t.kit.org.id],
    );
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { host: 'api.example.com', status: 200, ok: true },
      { host: 'api.example.com', status: 401, ok: false },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/audit-tok|person@example/);
  });
});
