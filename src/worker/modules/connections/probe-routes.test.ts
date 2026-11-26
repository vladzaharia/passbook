import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all } from '../../platform/db.ts';
import { resetDeps, setDeps } from './deps.ts';
import { BASE, probeApp, reply, upstream } from './probe-fixtures.ts';
import { publicResolver } from './test-kit.ts';

let t: Awaited<ReturnType<typeof probeApp>>;
beforeEach(async () => {
  t = await probeApp();
});
afterEach(() => resetDeps());

const ids = (...v: string[]) => v.map((id) => ({ id }));

describe('POST /connections/probe: what comes back', () => {
  it('Stripe: a page of records, detections, and a token that proves page 2 without overlap', async () => {
    const calls = upstream((url) =>
      url.searchParams.get('starting_after') === 'cus_2'
        ? { object: 'list', data: ids('cus_3'), has_more: false }
        : { object: 'list', data: ids('cus_1', 'cus_2'), has_more: true },
    );
    const config = {
      list: {
        path: '/customers',
        recordsPointer: '/data',
        pagination: {
          style: 'cursor',
          param: 'starting_after',
          from: 'last-id',
          hasMorePointer: '/has_more',
        },
      },
    };
    const first = await t.probe(config);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      ok: true,
      request: {
        method: 'GET',
        url: `${BASE}/customers`,
        status: 200,
        contentType: 'application/json',
      },
      page: { index: 1, from: 1, to: 2, overlap: 0 },
      detections: {
        records: [{ pointer: '/data', jsonPath: '$.data[*]', count: 2, reason: 'name' }],
        id: [{ pointer: '/id', unique: true }],
        pagination: [{ confidence: 'high', config: { style: 'cursor', from: 'last-id' } }],
      },
    });
    expect(first.json.page.next).toEqual(expect.any(String));
    const second = await t.probe(config, { next: first.json.page.next });
    expect(second.json).toMatchObject({
      ok: true,
      page: { index: 2, from: 3, to: 3, overlap: 0, next: null },
    });
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/customers`,
      `${BASE}/customers?starting_after=cus_2`,
    ]);
  });

  it('counts the IDs a second page repeats: the API ignores our paging', async () => {
    upstream(() => ({ items: ids('a', 'b', 'c') }));
    const config = { list: { path: '/m', pagination: { style: 'page', param: 'page', start: 1 } } };
    const first = await t.probe(config);
    const second = await t.probe(config, { next: first.json.page.next });
    expect(second.json.page).toMatchObject({ index: 2, overlap: 3 });
  });

  it('follows a Link header and reports the headers it allows', async () => {
    upstream((url) =>
      reply(200, ids('a'), {
        link: `<${BASE}/repos?page=2>; rel="next"`,
        'set-cookie': 'sid=1',
        'x-secret-thing': 'no',
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
        etag: '"abc"',
        'x-next-page': url.search ? '3' : '2',
      }),
    );
    const out = await t.probe({
      list: { path: '/repos', recordsPointer: '', pagination: { style: 'link-header' } },
    });
    expect(Object.keys(out.json.headers).sort()).toEqual([
      'content-type',
      'etag',
      'link',
      'x-next-page',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
    ]);
    expect(out.json.detections.rateLimit).toEqual({ limit: 60, remaining: 59 });
    expect(out.json.detections.pagination[0].config).toEqual({ style: 'link-header' });
    expect(out.json.page.next).toEqual(expect.any(String));
  });

  it('prunes a long page and says what it cut', async () => {
    upstream(() => ({
      data: Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, bio: 'x'.repeat(900) })),
    }));
    const out = await t.probe({ list: { path: '/m', recordsPointer: '/data' } });
    expect(out.json.body.data).toHaveLength(25);
    expect(out.json.body.data[0].bio).toHaveLength(501);
    expect(out.json.pruned).toMatchObject({
      arrays: [{ pointer: '/data', total: 300, shown: 25 }],
      strings: 25,
    });
    expect(out.json.page).toMatchObject({ from: 1, to: 300 });
  });

  it('a record probe returns the record fields and no page', async () => {
    upstream(() => ({
      data: { id: 'm-1', email: 'a@example.com', updated_at: '2026-01-01T00:00:00Z' },
    }));
    const out = await t.probe(
      { recordPath: '/members/{ref}', recordPointer: '/data', testRef: 'm-1' },
      { target: 'record' },
    );
    expect(out.json).toMatchObject({
      ok: true,
      page: null,
      detections: {
        records: [],
        holderEmail: [{ pointer: '/email' }],
        updatedAt: [{ pointer: '/updated_at' }],
      },
    });
  });

  it('a wrong records pointer is NO_RECORDS, with candidates to pick from', async () => {
    upstream(() => ({ results: ids('a', 'b') }));
    const out = await t.probe({ list: { path: '/m' } });
    expect(out.json).toMatchObject({
      ok: false,
      errorCode: 'NO_RECORDS',
      detections: { records: [{ pointer: '/results' }] },
    });
  });

  it('a next link on another host is OFF_ORIGIN and is never fetched', async () => {
    const calls = upstream(() => ({ items: ids('a'), next: 'https://evil.example/steal' }));
    const out = await t.probe({
      list: { path: '/m', pagination: { style: 'next-link', nextPointer: '/next' } },
    });
    expect(out.json).toMatchObject({ ok: false, errorCode: 'OFF_ORIGIN', page: { next: null } });
    expect(calls).toHaveLength(1);
  });

  it('a forged next token is refused before any request', async () => {
    const calls = upstream(() => ({ items: [] }));
    const body = btoa(
      JSON.stringify({ p: { u: 'https://evil.example/x' }, k: 1, n: 0, ids: [] }),
    ).replace(/=+$/, '');
    for (const forged of [`p2.${body}.${'0'.repeat(32)}`, `p2.${body}`, `p1.${body}`, 'nonsense']) {
      const out = await t.probe({ list: { path: '/m' } }, { next: forged });
      expect(out.json).toMatchObject({ ok: false, errorCode: 'CONFIG' });
    }
    expect(calls).toHaveLength(0);
  });

  it('a token is bound to its org, origin and base path', async () => {
    const calls = upstream(() => ({ items: ids('a', 'b'), next: '/v1/m?page=2' }));
    const config = {
      list: { path: '/m', pagination: { style: 'next-link', nextPointer: '/next' } },
    };
    const first = await t.probe(config);
    expect(first.json.page.next).toEqual(expect.any(String));
    const otherHost = await t.call('/api/v1/connections/probe', {
      orgId: t.kit.org.id,
      connectorType: 'http-json',
      config: { baseUrl: 'https://other.example.com/v1', ...config },
      target: 'list',
      next: first.json.page.next,
    });
    expect(otherHost.json.errorCode).toBe('CONFIG');
    const otherPath = await t.probe(
      { baseUrl: 'https://api.example.com/v2', ...config },
      { next: first.json.page.next },
    );
    expect(otherPath.json.errorCode).toBe('CONFIG');
    expect(calls).toHaveLength(1);
    expect((await t.probe(config, { next: first.json.page.next })).json.ok).toBe(true);
  });

  it('keeps the answer small whatever the upstream sends', async () => {
    const inner: Record<string, number[]> = {};
    for (let i = 0; i < 500; i++) inner[`a${i}`] = Array(3).fill(0);
    upstream(() => reply(200, JSON.stringify({ ['k'.repeat(300_000)]: inner })));
    const res = await t.app.request(
      '/api/v1/connections/probe',
      {
        method: 'POST',
        headers: { ...t.session.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          orgId: t.kit.org.id,
          connectorType: 'http-json',
          config: { baseUrl: BASE, list: { path: '/m' } },
          target: 'list',
        }),
      },
      t.kit.env,
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeLessThan(1_000_000);
  });

  it('a body nested 100,000 levels deep answers and is audited', async () => {
    const d = 100_000;
    upstream(() => reply(200, `{"data":${'['.repeat(d)}${']'.repeat(d)}}`));
    const out = await t.probe({ list: { path: '/m', recordsPointer: '/data' } });
    expect(out.status).toBe(200);
    const rows = await all(
      t.kit.env.DB,
      "SELECT id FROM audit_log WHERE org_id = ? AND action = 'connection.probe'",
      [t.kit.org.id],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('POST /connections/probe: failures say a code, never the upstream body', () => {
  const body = 'UPSTREAM-ERROR-BODY with <b>html</b> and Bearer leaked-token';
  const cases: [number, string][] = [
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [500, 'UPSTREAM'],
    [502, 'UPSTREAM'],
  ];
  for (const [status, code] of cases) {
    it(`${status} is ${code}`, async () => {
      upstream(() => reply(status, body, { 'x-debug': body, 'set-cookie': 'a=b' }));
      const out = await t.probe({ list: { path: '/m' } });
      expect(out.json).toMatchObject({
        ok: false,
        errorCode: code,
        request: { status },
        headers: {},
        page: null,
        detections: null,
      });
      expect(out.json.body).toBeUndefined();
      expect(JSON.stringify(out.json)).not.toContain('UPSTREAM-ERROR-BODY');
    });
  }

  it('429 carries how long to wait', async () => {
    upstream(() => reply(429, 'slow down', { 'retry-after': '120' }));
    const out = await t.probe({ list: { path: '/m' } });
    expect(out.json).toMatchObject({ ok: false, errorCode: 'RATE_LIMITED', retryAfterMs: 120_000 });
  });

  it('a 200 that is not JSON is NOT_JSON, and its text is not returned', async () => {
    upstream(
      () => new Response('<html>login page</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const out = await t.probe({ list: { path: '/m' } });
    expect(out.json).toMatchObject({
      ok: false,
      errorCode: 'NOT_JSON',
      request: { status: 200, contentType: 'text/html' },
    });
    expect(JSON.stringify(out.json)).not.toContain('login page');
  });

  it('a page over the size cap is TOO_LARGE', async () => {
    upstream(() => reply(200, { items: [{ id: 'a', pad: 'x'.repeat(600_000) }] }));
    expect((await t.probe({ list: { path: '/m' } })).json).toMatchObject({
      ok: false,
      errorCode: 'TOO_LARGE',
    });
  });

  it('more than 1,000 records on a page is TOO_LARGE', async () => {
    upstream(() => ({ items: Array.from({ length: 1001 }, (_, i) => ({ id: i })) }));
    expect((await t.probe({ list: { path: '/m' } })).json.errorCode).toBe('TOO_LARGE');
  });

  it('a redirect is REDIRECT_BLOCKED', async () => {
    upstream(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    );
    expect((await t.probe({ list: { path: '/m' } })).json.errorCode).toBe('REDIRECT_BLOCKED');
  });

  it('a network failure that times out is TIMEOUT', async () => {
    setDeps({
      fetchImpl: async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
    });
    const out = await t.probe({ list: { path: '/m' } });
    expect(['TIMEOUT', 'UPSTREAM']).toContain(out.json.errorCode);
  });

  it('a private address is UNSAFE_URL, and nothing is fetched', async () => {
    const calls = upstream(() => ({}));
    const direct = await t.call('/api/v1/connections/probe', {
      orgId: t.kit.org.id,
      connectorType: 'http-json',
      config: { baseUrl: 'https://127.0.0.1/v1', list: { path: '/m' } },
      target: 'list',
    });
    expect(direct).toMatchObject({
      status: 200,
      json: { ok: false, errorCode: 'UNSAFE_URL', request: null },
    });
    setDeps({ resolver: { resolve: async () => ['10.0.0.5'] } });
    const rebound = await t.probe({ list: { path: '/m' } });
    expect(rebound.json).toMatchObject({ ok: false, errorCode: 'UNSAFE_URL' });
    setDeps({ resolver: publicResolver });
    expect(calls).toHaveLength(0);
  });

  it('an incomplete credential is CONFIG, with no request', async () => {
    const calls = upstream(() => ({}));
    const out = await t.probe({ list: { path: '/m' }, auth: { type: 'bearer' } });
    expect(out.json).toMatchObject({ ok: false, errorCode: 'CONFIG', request: null });
    expect(calls).toHaveLength(0);
  });
});
