import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import {
  HOUR_ROWS_CAP,
  insertLog,
  logCap,
  type NewLog,
  TOTAL_ROWS_CAP,
} from './repo-request-log.ts';
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
const badCreate = (d: Dev, body: unknown = {}) =>
  t.call('/passes', {
    ...post({
      templateId: 'no-such-template',
      input: { memberName: 'Ada Lovelace', note: 'hello' },
      email: 'ada@example.com',
      secret: SECRET,
      ...(body as object),
    }),
    headers: { ...JSON_HEADERS, ...bearer(d.key.secret) },
  });

const newLog = (orgId: string, over: Partial<NewLog> = {}): NewLog => {
  const id = t.kit.f.ids.id();
  return {
    id,
    orgId,
    keyId: 'k',
    via: null,
    mode: 'test',
    requestId: id,
    method: 'GET',
    route: null,
    path: '/api/v1/passes',
    query: null,
    status: 200,
    code: null,
    durationMs: 1,
    at: t.kit.clock.now(),
    requestBody: null,
    responseBody: null,
    ...over,
  };
};

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

  it('writes nothing for a Live call or a real org: no row, and no statement at all', async () => {
    const std = await makeOrg(t.kit.f);
    const live = await makeApiKey(t.kit.f, {
      orgId: std.id,
      mode: 'live',
      scopes: ['passes:read', 'passes:write'],
    });
    const test = await makeApiKey(t.kit.f, {
      orgId: std.id,
      mode: 'test',
      scopes: ['passes:read'],
    });
    const seen: string[] = [];
    const env = { ...t.kit.env, DB: gatedDb(t.kit.env.DB, Promise.resolve(), seen) };
    for (const key of [live, test]) {
      const res = await t.call('/passes?limit=5', { headers: key.headers }, env);
      expect(res.status).toBe(200);
    }
    await t.call(
      '/passes',
      {
        ...post({ templateId: 'x', input: { a: SECRET } }),
        headers: { ...JSON_HEADERS, ...live.headers },
      },
      env,
    );
    await t.settle();
    expect(await t.rows(std.id)).toHaveLength(0);
    expect(seen.filter((s) => s.includes('request_log'))).toEqual([]);
    // The insert is itself a developer-org write: a row for a real org is refused by the SELECT.
    expect(await insertLog(t.kit.env.DB, newLog(std.id, { requestBody: '{}' }))).toBe(false);
    expect(await insertLog(t.kit.env.DB, newLog(std.id, { mode: 'live' }))).toBe(false);
    expect(await t.rows(std.id)).toHaveLength(0);
  });

  it('refuses a body or a query value anywhere but a developer Test row, by trigger', async () => {
    const std = await makeOrg(t.kit.f);
    const dev = await t.developer();
    const raw = (orgId: string, mode: string, id: string, col: string) =>
      run(
        t.kit.env.DB,
        `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at, has_bodies, request_body, query)
         VALUES (?, ?, ?, 'r', 'GET', '/x', 200, 1, 1, ?, ?, ?)`,
        [
          id,
          orgId,
          mode,
          col === 'body' ? 1 : 0,
          col === 'body' ? '{}' : null,
          col === 'query' ? 'a=1' : null,
        ],
      );
    await expect(raw(std.id, 'test', 'raw-1', 'body')).rejects.toThrow(
      /developer Test traffic only/,
    );
    await expect(raw(std.id, 'test', 'raw-2', 'query')).rejects.toThrow(/query values/);
    await expect(raw(dev.made.orgId, 'live', 'raw-3', 'body')).rejects.toThrow(
      /Live data|Test traffic only/,
    );
    await run(
      t.kit.env.DB,
      `INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at) VALUES ('raw-4', ?, 'live', 'r', 'GET', '/x', 200, 1, 1)`,
      [std.id],
    );
    await expect(
      run(
        t.kit.env.DB,
        "UPDATE request_log SET has_bodies = 1, request_body = '{}' WHERE id = 'raw-4'",
      ),
    ).rejects.toThrow();
  });

  it('keeps the redacted query of a sandbox call, so a bad filter can be read back', async () => {
    const d = await t.developer();
    await t.call('/passes?limit=5&externalId=SENTINEL-7&status=active&pin=1234', {
      headers: bearer(d.key.secret),
    });
    await t.settle();
    expect((await t.rows(d.made.orgId))[0]?.query).toBe(
      'limit=5&externalId=%5Bredacted%5D&status=active&pin=%5Bredacted%5D',
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

  it('stores no body above 16 KB but keeps the call, and cancels what it will not read', async () => {
    const d = await t.developer();
    await badCreate(d, { input: { big: 'x'.repeat(20_000) } });
    await t.call('/passes', {
      method: 'POST',
      headers: { 'content-type': 'text/csv', ...bearer(d.key.secret) },
      body: 'a,b\n1,2',
    });
    await t.settle();
    const rows = await t.rows(d.made.orgId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.request_body).sort()).toEqual([
      '[json, too large to keep]',
      '[text/csv]',
    ]);
    for (const r of rows) expect(String(r.request_body)).not.toContain('xxxx');
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
    for (let i = 0; i < 50 && !seen.some((s) => s.includes('request_log')); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(await t.rows(d.made.orgId)).toHaveLength(0);
    open();
    await t.settle();
    expect(await t.rows(d.made.orgId)).toHaveLength(1);
    const touching = seen.filter((s) => s.includes('request_log'));
    expect(touching).toHaveLength(1);
    expect(touching[0]).toMatch(/^\s*INSERT INTO request_log/);
  });
});

describe('the sandbox caps', () => {
  it('records no more than 2,000 rows an hour, and the next hour starts again', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    await run(
      db,
      'INSERT INTO request_log_budget (org_id, hour, hour_rows, total_rows) VALUES (?, ?, ?, ?)',
      [
        d.made.orgId,
        Math.floor(t.kit.clock.now() / 3_600_000),
        HOUR_ROWS_CAP - 1,
        HOUR_ROWS_CAP - 1,
      ],
    );
    expect(await insertLog(db, newLog(d.made.orgId))).toBe(true);
    expect(await logCap(db, d.made.orgId, t.kit.clock.now())).toBe('hour');
    expect(await insertLog(db, newLog(d.made.orgId))).toBe(false);
    await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.settle();
    expect(await t.rows(d.made.orgId)).toHaveLength(1);
    const later = t.kit.clock.now() + 3_600_000;
    expect(await logCap(db, d.made.orgId, later)).toBeNull();
    expect(await insertLog(db, newLog(d.made.orgId, { at: later }))).toBe(true);
    expect(
      await first<{ hour_rows: number }>(
        db,
        'SELECT hour_rows FROM request_log_budget WHERE org_id = ?',
        [d.made.orgId],
      ),
    ).toMatchObject({ hour_rows: 1 });
  });

  it('holds at most 20,000 rows in all, says so in the log, and frees room as rows expire', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    await run(
      db,
      'INSERT INTO request_log_budget (org_id, hour, hour_rows, total_rows) VALUES (?, 0, 0, ?)',
      [d.made.orgId, TOTAL_ROWS_CAP],
    );
    expect(await insertLog(db, newLog(d.made.orgId, { requestBody: '{}' }))).toBe(false);
    const res = await t.call('/developer/logs', { headers: d.browser });
    expect(await res.json()).toMatchObject({ capped: 'total', items: [] });
    await run(db, 'UPDATE request_log_budget SET total_rows = ? WHERE org_id = ?', [
      TOTAL_ROWS_CAP - 1,
      d.made.orgId,
    ]);
    expect(await insertLog(db, newLog(d.made.orgId))).toBe(true);
    // A delete returns the room.
    await run(db, 'DELETE FROM request_log WHERE org_id = ?', [d.made.orgId]);
    expect(
      (
        await first<{ total_rows: number }>(
          db,
          'SELECT total_rows FROM request_log_budget WHERE org_id = ?',
          [d.made.orgId],
        )
      )?.total_rows,
    ).toBe(TOTAL_ROWS_CAP - 1);
  });
});
