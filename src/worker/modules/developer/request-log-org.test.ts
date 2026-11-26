import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { RequestLogDetailSchema, RequestLogPageSchema } from '../../../shared/contracts/index.ts';
import { run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { bearer } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

const asTest = (h: Record<string, string>) => ({ ...h, 'x-passbook-mode': 'test' });
const SECRETS = ['Bearer-SECRET-1', 'cookie-SECRET-2', 'sig-SECRET-3', 'apikey-SECRET-4'];

async function realOrg() {
  const org = await makeOrg(t.kit.f);
  const key = await makeApiKey(t.kit.f, {
    orgId: org.id,
    mode: 'test',
    scopes: ['passes:read', 'passes:write', 'logs:read'],
  });
  return { org, key };
}

describe('the org request log', () => {
  it('records resource id, api version and header flags, and never a header value', async () => {
    const { org, key } = await realOrg();
    const id = t.kit.f.ids.id();
    await t.call(`/passes/${id}`, {
      headers: {
        ...key.headers,
        'passbook-version': '2026-11-20',
        'idempotency-key': 'idem-SECRET-VALUE',
        'if-match': '"etag-SECRET"',
        cookie: SECRETS[1] ?? '',
        'x-signature': SECRETS[2] ?? '',
        'x-api-key': SECRETS[3] ?? '',
      },
    });
    await t.call('/passes', { headers: key.headers });
    await t.settle();
    const rows = await t.rows(org.id);
    const one = rows.find((r) => r.resource_id === id);
    expect(one).toMatchObject({ api_version: '2026-11-20', flags: 7 });
    const plain = rows.find((r) => r.resource_id === null);
    expect(plain).toMatchObject({ api_version: null, flags: 0 });
    const everything = JSON.stringify(rows);
    for (const secret of [...SECRETS, 'idem-SECRET-VALUE', 'etag-SECRET', key.secret])
      expect(everything, secret).not.toContain(secret);
  });

  it('lists by passId and version, Test only, to a key with logs:read', async () => {
    const { org, key } = await realOrg();
    const id = t.kit.f.ids.id();
    await t.call(`/passes/${id}`, {
      headers: { ...key.headers, 'passbook-version': '2026-11-20' },
    });
    await t.call('/passes', { headers: key.headers });
    await t.settle();
    const read = async (q: string) =>
      RequestLogPageSchema.parse(
        await (await t.call(`/request-logs${q}`, { headers: key.headers })).json(),
      );
    expect((await read('')).items).toHaveLength(2);
    const byPass = await read(`?passId=${id}`);
    expect(byPass.items).toHaveLength(1);
    expect(byPass.items[0]).toMatchObject({
      resourceId: id,
      apiVersion: '2026-11-20',
      flags: { version: true, idempotencyKey: false, ifMatch: false },
    });
    expect((await read('?version=2026-11-20')).items).toHaveLength(1);
    expect((await read('?version=2026-11-22')).items).toHaveLength(0);
    // Tailing: only newer than a known id.
    const all = await read('');
    expect((await read(`?after=${all.items[0]?.id}`)).items).toHaveLength(0);
    expect(
      (await t.call('/request-logs', { headers: key.headers })).headers.get('cache-control'),
    ).toBe('no-store');
    expect(await t.rows(org.id)).toHaveLength(2);
  });

  it('refuses a key without the scope, another org, and reading the log is not logged', async () => {
    const { org, key } = await realOrg();
    const other = await realOrg();
    const noScope = await makeApiKey(t.kit.f, {
      orgId: org.id,
      mode: 'test',
      scopes: ['passes:read'],
    });
    await expectProblem(
      await t.call('/request-logs', { headers: noScope.headers }),
      403,
      'MISSING_SCOPE',
    );
    await expectProblem(
      await t.call(`/request-logs?orgId=${other.org.id}`, { headers: key.headers }),
      403,
      'ORG_FORBIDDEN',
    );
    await t.settle();
    expect(await t.rows(org.id)).toHaveLength(0);
  });

  it('lets a member read their org by session, and no one else', async () => {
    const a = await t.developer();
    const b = await t.developer();
    await t.call('/passes', { headers: bearer(a.key.secret) });
    await t.settle();
    const res = await t.call(`/request-logs?orgId=${a.made.orgId}`, { headers: asTest(a.browser) });
    expect(res.status, await res.clone().text()).toBe(200);
    const page = RequestLogPageSchema.parse(await res.json());
    expect(page.items).toHaveLength(1);
    expect(page.bodiesRecorded).toBe(true);
    const detail = RequestLogDetailSchema.parse(
      await (
        await t.call(`/request-logs/${page.items[0]?.id}?orgId=${a.made.orgId}`, {
          headers: asTest(a.browser),
        })
      ).json(),
    );
    expect(detail.bodiesRecorded).toBe(true);
    const denied = await t.call(`/request-logs?orgId=${a.made.orgId}`, {
      headers: asTest(b.browser),
    });
    expect(denied.status).toBeGreaterThanOrEqual(403);
  });

  it('reports bodies off for a regular org until its setting turns them on', async () => {
    const { org, key } = await realOrg();
    const read = async () =>
      RequestLogPageSchema.parse(
        await (await t.call('/request-logs', { headers: key.headers })).json(),
      );
    expect((await read()).bodiesRecorded).toBe(false);
    await run(
      t.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'requestLog.bodies', 'true', 1)",
      [`org:${org.id}`],
    );
    clearSettingsCache(t.kit.env.DB);
    expect((await read()).bodiesRecorded).toBe(true);
  });
});

describe('what a real org keeps', () => {
  const enable = async (orgId: string, on: boolean) => {
    await run(
      t.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'requestLog.bodies', ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      [`org:${orgId}`, on ? 'true' : 'false'],
    );
    clearSettingsCache(t.kit.env.DB);
  };

  it('stores nothing of a pass input, with bodies on', async () => {
    const { org, key } = await realOrg();
    await enable(org.id, true);
    await t.call('/passes?customerId=SENTINEL-Q&limit=5', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...key.headers },
      body: JSON.stringify({
        templateId: 'no-such-template',
        input: { customerId: 'SENTINEL-C-998877', birthdayAt: 315532800000 },
      }),
    });
    await t.settle();
    const [row] = await t.rows(org.id);
    expect(JSON.stringify(row)).not.toContain('SENTINEL');
    expect(String(row?.query)).toContain('limit=5');
  });

  it('shows bodies only to a reader who can also read passes, and says when one was cut', async () => {
    const { org, key } = await realOrg();
    await enable(org.id, true);
    await run(
      t.kit.env.DB,
      `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at, has_bodies, request_body, response_body, bodies_truncated)
       VALUES ('log-trunc', ?, 'test', 'r1', 'GET', '/x', 200, 1, ?, 1, '{"a":1}', '{"b":2}…[truncated]', 1)`,
      [org.id, t.kit.clock.now()],
    );
    const logsOnly = await makeApiKey(t.kit.f, {
      orgId: org.id,
      mode: 'test',
      scopes: ['logs:read'],
    });
    const seen = RequestLogDetailSchema.parse(
      await (await t.call('/request-logs/log-trunc', { headers: key.headers })).json(),
    );
    expect(seen).toMatchObject({ requestBody: '{"a":1}', bodiesTruncated: true, hasBodies: true });
    const hidden = RequestLogDetailSchema.parse(
      await (await t.call('/request-logs/log-trunc', { headers: logsOnly.headers })).json(),
    );
    expect(hidden).toMatchObject({
      requestBody: null,
      responseBody: null,
      hasBodies: false,
      bodiesTruncated: false,
    });
    const list = RequestLogPageSchema.parse(
      await (await t.call('/request-logs', { headers: logsOnly.headers })).json(),
    );
    expect(list.items.every((i) => !i.hasBodies)).toBe(true);
  });

  it('blanks the stored bodies when an admin turns recording off', async () => {
    const d = await t.developer();
    const put = (value: boolean) =>
      t.call('/settings', {
        method: 'PUT',
        headers: { ...asTest(d.browser), 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: `org:${d.made.orgId}`,
          values: { 'requestLog.bodies': value },
        }),
      });
    expect((await put(true)).status).toBe(200);
    await run(
      t.kit.env.DB,
      `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at, has_bodies, request_body)
       VALUES ('log-off', ?, 'test', 'r2', 'GET', '/x', 200, 1, ?, 1, '{"a":1}')`,
      [d.made.orgId, t.kit.clock.now()],
    );
    const res = await put(false);
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await t.rows(d.made.orgId);
    expect(row).toMatchObject({ has_bodies: 0, request_body: null });
  });
});
