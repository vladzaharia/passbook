import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { RequestLogDetailSchema } from '../../../shared/contracts/index.ts';
import { codeOf } from '../../../web/workbench/logs/curl.ts';
import { first, run } from '../../platform/db.ts';
import { headersJson, headersOf } from './request-log-headers.ts';
import { logKit } from './request-log-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

async function realOrg() {
  const org = await makeOrg(t.kit.f);
  const key = await makeApiKey(t.kit.f, {
    orgId: org.id,
    mode: 'test',
    scopes: ['passes:read', 'passes:write', 'logs:read'],
  });
  return { org, key };
}

const readDetail = async (headers: Record<string, string>, orgId: string) => {
  await t.settle();
  const row = (await t.rows(orgId))[0] as { id: string };
  const res = await t.call(`/request-logs/${row.id}`, { headers });
  expect(res.status).toBe(200);
  return RequestLogDetailSchema.parse(await res.json());
};

describe('request log headers', () => {
  it('keeps the allowlist and no secret: not in the row, the API or anywhere', async () => {
    const { org, key } = await realOrg();
    const secrets = ['cookie-SECRET', 'apikey-SECRET', 'whsec-SECRET', 'custom-SECRET'];
    await t.call('/passes?limit=1', {
      headers: {
        ...key.headers,
        accept: 'application/json',
        'idempotency-key': 'idem-1',
        'passbook-version': '2026-11-20',
        'if-match': '"v1"',
        'user-agent': 'my-tool/1.0',
        cookie: secrets[0] ?? '',
        'x-api-key': secrets[1] ?? '',
        'stripe-signature': secrets[2] ?? '',
        'x-custom': secrets[3] ?? '',
      },
    });
    const detail = await readDetail(key.headers, org.id);
    expect(detail.headers?.req).toMatchObject({
      accept: 'application/json',
      'idempotency-key': 'idem-1',
      'passbook-version': '2026-11-20',
      'if-match': '"v1"',
      'user-agent': 'my-tool/1.0',
    });
    expect(Object.keys(detail.headers?.res ?? {})).toContain('content-type');
    const everything = JSON.stringify(await t.rows(org.id)) + JSON.stringify(detail);
    for (const secret of [...secrets, key.secret]) expect(everything, secret).not.toContain(secret);
    for (const name of ['authorization', 'cookie', 'x-api-key', 'stripe-signature', 'x-custom'])
      expect(Object.keys(detail.headers?.req ?? {})).not.toContain(name);
  });

  it('keeps a 4xx clean too: the same secrets, nothing stored', async () => {
    const { org, key } = await realOrg();
    const secrets = ['cookie', 'apikey', 'whsec'].map((p) => [p, 'SECRET4'].join('-'));
    const res = await t.call(`/passes/${t.kit.f.ids.id()}`, {
      headers: {
        ...key.headers,
        cookie: secrets[0] ?? '',
        'x-api-key': secrets[1] ?? '',
        'stripe-signature': secrets[2] ?? '',
      },
    });
    expect(res.status).toBe(404);
    const detail = await readDetail(key.headers, org.id);
    const everything = JSON.stringify(await t.rows(org.id)) + JSON.stringify(detail);
    for (const secret of [...secrets, key.secret]) expect(everything, secret).not.toContain(secret);
    expect(detail.status).toBe(404);
  });

  it('is not on the list read', async () => {
    const { org, key } = await realOrg();
    await t.call('/passes?limit=1', { headers: key.headers });
    await t.settle();
    const page = (await (await t.call('/request-logs', { headers: key.headers })).json()) as {
      items: object[];
    };
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(item).not.toHaveProperty('headers');
    expect(org.id).toBeTruthy();
  });

  it('returns null for an older row', async () => {
    const { org, key } = await realOrg();
    await t.call('/passes?limit=1', { headers: key.headers });
    await t.settle();
    await run(t.kit.env.DB, 'UPDATE request_log SET headers = NULL WHERE org_id = ?', [org.id]);
    expect((await readDetail(key.headers, org.id)).headers).toBeNull();
    const stored = await first<{ headers: string | null }>(
      t.kit.env.DB,
      'SELECT headers FROM request_log WHERE org_id = ?',
      [org.id],
    );
    expect(stored?.headers).toBeNull();
  });
});

describe('header value redaction', () => {
  it('redacts an email or a key in user-agent and idempotency-key: row, API and curl', async () => {
    const { org, key } = await realOrg();
    await t.call('/passes?limit=1', {
      headers: {
        ...key.headers,
        'user-agent': 'tool/1 ada@example.com',
        'idempotency-key': ['pb', 'test', 'abcdef123456'].join('_'),
      },
    });
    const detail = await readDetail(key.headers, org.id);
    const curl = codeOf('curl', detail, 'https://x.test');
    const everything = JSON.stringify(await t.rows(org.id)) + JSON.stringify(detail) + curl;
    for (const raw of ['ada@example.com', ['pb', 'test', 'abcdef123456'].join('_')])
      expect(everything, raw).not.toContain(raw);
    expect(detail.headers?.req['user-agent']).toBe('tool/1 [redacted email]');
    expect(detail.headers?.req['idempotency-key']).toBe('pb_[redacted]');
    expect(curl).toContain('tool/1 [redacted email]');
  });
});

describe('headersJson', () => {
  const none = new Headers();
  const stored = (get: (n: string) => string | undefined, res = none) =>
    headersOf(headersJson(get, res));

  it('matches names case-insensitively and stores them lowercase', () => {
    const res = new Headers({ ETag: '"x"', 'Retry-After': '5', 'Set-Cookie': 'sid=SECRET' });
    const out = stored((n) => ({ 'idempotency-key': 'k1' })[n], res);
    expect(out).toEqual({
      req: { 'idempotency-key': 'k1' },
      res: { etag: '"x"', 'retry-after': '5' },
    });
  });

  it('truncates a long user-agent, drops other long values and non-ASCII ones', () => {
    const out = stored(
      (n) =>
        ({
          'user-agent': 'u'.repeat(400),
          accept: 'a'.repeat(300),
          'idempotency-key': 'clé-é',
          'passbook-version': '2026-11-20',
        })[n],
    );
    expect(out?.req['user-agent']).toHaveLength(256);
    expect(out?.req['user-agent']?.endsWith('…')).toBe(true);
    expect(out?.req).not.toHaveProperty('accept');
    expect(out?.req).not.toHaveProperty('idempotency-key');
    expect(out?.req['passbook-version']).toBe('2026-11-20');
  });

  it('redacts a capability URL in Location', () => {
    const res = new Headers({ Location: 'https://x.test/p/abcdefghijklmnop1234' });
    expect(stored(() => undefined, res)?.res.location).toBe('https://x.test/p/[redacted]');
  });

  it('reads back only allowlisted names', () => {
    const json = JSON.stringify({
      req: { accept: 'a', authorization: 'SECRET' },
      res: { 'set-cookie': 'S' },
    });
    expect(headersOf(json)).toEqual({ req: { accept: 'a' }, res: {} });
  });

  it('stores a repeated accept merged, and the first of a repeated idempotency-key', () => {
    const get = (n: string) =>
      ({ accept: 'text/html, application/json', 'idempotency-key': 'a, b' })[n];
    expect(stored(get)?.req).toEqual({
      accept: 'text/html, application/json',
      'idempotency-key': 'a',
    });
  });

  it('keeps the first value of a repeated header', () => {
    expect(stored((n) => (n === 'idempotency-key' ? 'one, two' : undefined))?.req).toEqual({
      'idempotency-key': 'one',
    });
  });

  it('stores nothing when none is on the list, and reads a bad value as none', () => {
    expect(headersJson(() => undefined, none)).toBeNull();
    expect(headersOf(null)).toBeNull();
    expect(headersOf('not json')).toBeNull();
  });
});
