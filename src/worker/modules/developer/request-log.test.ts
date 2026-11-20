import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { writeLog } from './request-log.ts';
import { gatedDb, type Kit, logKit } from './request-log-test-fixtures.ts';
import { bearer } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

const JSON_HEADERS = { 'content-type': 'application/json' };
const SECRET = 'SENTINEL-SECRET-VALUE';
const post = (body: unknown) => ({
  method: 'POST',
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});
type Dev = Awaited<ReturnType<Kit['developer']>>;

/** A failing pass create with personal data in its body, sent with the sandbox's own key. */
const badCreate = (d: Dev) =>
  t.call('/passes', {
    ...post({
      templateId: 'no-such-template',
      input: { memberName: 'Ada Lovelace', note: 'hello' },
      email: 'ada@example.com',
      secret: SECRET,
    }),
    headers: { ...JSON_HEADERS, ...bearer(d.key.secret) },
  });

describe('the request log writes', () => {
  it('keeps metadata, the error code and redacted bodies of a sandbox Test call', async () => {
    const d = await t.developer();
    const res = await badCreate(d);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await t.settle();
    const [row] = await t.rows(d.made.orgId);
    expect(row).toMatchObject({
      method: 'POST',
      route: '/api/v1/passes',
      path: '/api/v1/passes',
      mode: 'test',
      key_id: d.key.id,
      status: res.status,
      has_bodies: 1,
    });
    expect(row?.code).toMatch(/^[A-Z_]+$/);
    const stored = `${row?.request_body}${row?.response_body}`;
    expect(String(row?.request_body)).toContain('no-such-template');
    for (const leak of [SECRET, 'Ada Lovelace', 'ada@example.com', 'hello'])
      expect(stored, leak).not.toContain(leak);
  });

  it('never stores a body for Live traffic, and the table refuses one', async () => {
    const std = await makeOrg(t.kit.f);
    const key = await makeApiKey(t.kit.f, {
      orgId: std.id,
      mode: 'live',
      scopes: ['passes:write'],
    });
    await t.call('/passes', {
      ...post({ templateId: 'x', input: { a: SECRET } }),
      headers: { ...JSON_HEADERS, ...key.headers },
    });
    await t.settle();
    const rows = await t.rows(std.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mode: 'live',
      has_bodies: 0,
      request_body: null,
      response_body: null,
    });
    expect(rows[0]?.status).toBeGreaterThanOrEqual(400);
    expect(rows[0]?.code).not.toBeNull();

    // A Live call keeps the names of its query parameters, never their values.
    const reader = await makeApiKey(t.kit.f, {
      orgId: std.id,
      mode: 'live',
      scopes: ['passes:read'],
    });
    await t.call('/passes?limit=5&q=Ada%20Lovelace&externalId=SENTINEL-7', {
      headers: reader.headers,
    });
    await t.settle();
    const listed = (await t.rows(std.id)).find((r) => r.key_id === reader.id);
    expect(listed?.query).toBe('limit&q&externalId');

    // The write path: a body handed to a Live row, or to a Test row of a standard org, is not bound at all.
    const body = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });
    for (const mode of ['live', 'test'] as const) {
      const id = t.kit.f.ids.id();
      await writeLog(
        t.ctx(),
        {
          id,
          orgId: std.id,
          keyId: key.id,
          via: null,
          mode,
          requestId: id,
          method: 'POST',
          route: null,
          path: '/api/v1/passes',
          query: null,
          queryKeys: null,
          status: 200,
          durationMs: 1,
          at: t.kit.clock.now(),
        },
        {
          test: true,
          type: 'application/json',
          requestType: 'application/json',
          sent: body('{"a":1}'),
          received: body('{"b":2}'),
        },
      );
      const stored = await first<Record<string, unknown>>(
        t.kit.env.DB,
        'SELECT * FROM request_log WHERE id = ?',
        [id],
      );
      expect(stored, mode).toMatchObject({
        has_bodies: 0,
        request_body: null,
        response_body: null,
      });
    }
    // And a direct write of one is refused by the triggers, on insert and on update.
    const raw = (orgId: string, mode: string, id: string) =>
      run(
        t.kit.env.DB,
        `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at, has_bodies, request_body)
         VALUES (?, ?, ?, 'r', 'GET', '/x', 200, 1, 1, 1, '{}')`,
        [id, orgId, mode],
      );
    await expect(raw(std.id, 'test', 'raw-1')).rejects.toThrow(/developer Test traffic only/);
    const dev = await t.developer();
    await expect(raw(dev.made.orgId, 'live', 'raw-2')).rejects.toThrow(
      /holds no Live data|developer Test traffic only/,
    );
    await run(
      t.kit.env.DB,
      `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at) VALUES ('raw-3', ?, 'live', 'r', 'GET', '/x', 200, 1, 1)`,
      [std.id],
    );
    await expect(
      run(
        t.kit.env.DB,
        "UPDATE request_log SET has_bodies = 1, request_body = '{}' WHERE id = 'raw-3'",
      ),
    ).rejects.toThrow();
  });

  it('keeps the redacted query of a sandbox call, so a bad filter can be read back', async () => {
    const d = await t.developer();
    await t.call('/passes?limit=5&externalId=SENTINEL-7&status=active', {
      headers: bearer(d.key.secret),
    });
    await t.settle();
    expect((await t.rows(d.made.orgId))[0]?.query).toBe(
      'limit=5&externalId=%5Bredacted%5D&status=active',
    );
  });

  it('does not log session traffic, unauthenticated calls or reads of the log itself', async () => {
    const d = await t.developer();
    await t.call('/passes', { headers: d.browser });
    await t.call('/passes');
    await t.call('/developer/logs', { headers: d.browser });
    await t.settle();
    expect(await t.rows(d.made.orgId)).toHaveLength(0);
  });

  it('costs the request one background write: the response is back while the insert is still held', async () => {
    const d = await t.developer();
    const seen: string[] = [];
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const env = { ...t.kit.env, DB: gatedDb(t.kit.env.DB, gate, seen) };
    const res = await t.call('/passes', { headers: bearer(d.key.secret) }, env);
    expect(res.status).toBe(200);
    // The response is complete while the one insert is still held: the request did not wait for it.
    for (let i = 0; i < 50 && !seen.some((s) => s.includes('request_log')); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(await t.rows(d.made.orgId)).toHaveLength(0);
    open();
    await t.settle();
    expect(await t.rows(d.made.orgId)).toHaveLength(1);
    // Nothing else touched the table: one statement, an INSERT.
    const touching = seen.filter((s) => s.includes('request_log'));
    expect(touching).toHaveLength(1);
    expect(touching[0]).toMatch(/^\s*INSERT INTO request_log/);
  });
});
