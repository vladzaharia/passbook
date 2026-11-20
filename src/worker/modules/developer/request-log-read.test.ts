import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { RequestLogDetailSchema, RequestLogPageSchema } from '../../../shared/contracts/index.ts';
import { first, run } from '../../platform/db.ts';
import { insertLog, LOG_BODY_MS, LOG_META_MS, type NewLog } from './repo-request-log.ts';
import { minutelyRequestLogPurge, purgeRequestLog } from './request-log-jobs.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { BROWSER, bearer, fromPage } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
});
afterAll(() => t.unstub());

const HOUR = 3_600_000;
const entry = (orgId: string, keyId: string, over: Partial<NewLog> = {}): NewLog => {
  const id = t.kit.f.ids.id();
  return {
    id,
    orgId,
    keyId,
    via: null,
    mode: 'test',
    requestId: id,
    method: 'GET',
    route: '/api/v1/passes',
    path: '/api/v1/passes',
    query: null,
    status: 200,
    code: null,
    durationMs: 4,
    at: t.kit.clock.now(),
    requestBody: '{"a":1}',
    responseBody: '{"b":2}',
    ...over,
  };
};
const countOf = async (where: string) =>
  (await first<{ n: number }>(t.kit.env.DB, `SELECT count(*) AS n FROM request_log WHERE ${where}`))
    ?.n;

describe('GET /developer/logs', () => {
  it('lists only the caller’s sandbox, by session or try token, and never takes an org from the request', async () => {
    const a = await t.developer();
    const b = await t.developer();
    for (const d of [a, b]) await t.call('/passes', { headers: bearer(d.key.secret) });
    await t.call('/passes/none', { headers: bearer(a.key.secret) });
    await t.settle();
    const { token } = await t.mint(a.browser);

    const bySession = RequestLogPageSchema.parse(
      await (await t.call('/developer/logs', { headers: a.browser })).json(),
    );
    expect(bySession.items).toHaveLength(2);
    const byToken = RequestLogPageSchema.parse(
      await (await t.call('/developer/logs', { headers: fromPage(a.browser, token) })).json(),
    );
    expect(byToken.items.map((i) => i.id)).toEqual(bySession.items.map((i) => i.id));
    const ownRows = await t.rows(a.made.orgId);
    expect(new Set(bySession.items.map((i) => i.keyId))).toEqual(new Set([a.key.id]));
    expect(bySession.items.map((i) => i.id).sort()).toEqual(ownRows.map((r) => r.id).sort());

    // B's row is not reachable by id, and an org id in the query is ignored.
    const bRow = (await t.rows(b.made.orgId))[0];
    await expectProblem(
      await t.call(`/developer/logs/${bRow?.id}`, { headers: a.browser }),
      404,
      'REQUEST_LOG_NOT_FOUND',
    );
    await expectProblem(
      await t.call(`/developer/logs/${bRow?.id}`, { headers: fromPage(a.browser, token) }),
      404,
      'REQUEST_LOG_NOT_FOUND',
    );
    const asked = await t.call(`/developer/logs?orgId=${b.made.orgId}`, { headers: a.browser });
    expect(((await asked.json()) as { items: unknown[] }).items).toHaveLength(2);
  });

  it('refuses a stranger: no sandbox, no session, a real key, and another person’s try token', async () => {
    const a = await t.developer();
    const lone = await makeSession(t.kit.f, { userId: (await makeUser(t.kit.f)).id });
    await expectProblem(
      await t.call('/developer/logs', { headers: { ...lone.headers, ...BROWSER } }),
      404,
      'SANDBOX_NOT_FOUND',
    );
    await expectProblem(
      await t.call('/developer/logs', { headers: BROWSER }),
      401,
      'UNAUTHENTICATED',
    );
    await expectProblem(await t.call('/developer/logs', { headers: bearer(a.key.secret) }), 401, [
      'UNAUTHENTICATED',
      'INVALID_API_KEY',
    ]);
    const b = await t.developer();
    const { token } = await t.mint(b.browser);
    // B's token beside A's session cookie: the token is bound to B's session.
    await expectProblem(
      await t.call('/developer/logs', { headers: { ...a.browser, ...bearer(token) } }),
      401,
      'INVALID_API_KEY',
    );
  });

  it('filters by status, code, path, method and key, and pages by cursor', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    const rows = [
      entry(d.made.orgId, d.key.id, { status: 201, method: 'POST', path: '/api/v1/passes' }),
      entry(d.made.orgId, d.key.id, {
        status: 404,
        code: 'PASS_NOT_FOUND',
        path: '/api/v1/passes/abc',
      }),
      entry(d.made.orgId, d.key.id, {
        status: 422,
        code: 'VALIDATION',
        method: 'POST',
        path: '/api/v1/templates',
      }),
      entry(d.made.orgId, d.key.id, { status: 500, code: 'INTERNAL', path: '/api/v1/holders' }),
    ];
    for (const r of rows) await insertLog(db, r);
    const get = async (q: string) =>
      RequestLogPageSchema.parse(
        await (await t.call(`/developer/logs?${q}`, { headers: d.browser })).json(),
      );
    expect((await get('status=4xx')).items.map((i) => i.status).sort()).toEqual([404, 422]);
    expect((await get('status=500')).items).toHaveLength(1);
    expect((await get('code=VALIDATION')).items[0]?.path).toBe('/api/v1/templates');
    expect((await get('path=/passes')).items).toHaveLength(2);
    expect((await get('method=POST')).items).toHaveLength(2);
    expect((await get(`keyId=${d.key.id}`)).items).toHaveLength(4);
    expect((await get('keyId=other')).items).toHaveLength(0);
    const first = await get('limit=3');
    expect(first.nextCursor).not.toBeNull();
    const second = await get(`limit=3&cursor=${first.nextCursor}`);
    expect([...first.items, ...second.items]).toHaveLength(4);
    expect(second.nextCursor).toBeNull();
  });

  it('gives bodies for 24 hours and metadata for 7 days, whether or not the purge has run', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    const now = t.kit.clock.now();
    const fresh = entry(d.made.orgId, d.key.id, { at: now - HOUR });
    const stale = entry(d.made.orgId, d.key.id, { at: now - LOG_BODY_MS - HOUR });
    const old = entry(d.made.orgId, d.key.id, { at: now - LOG_META_MS - HOUR });
    for (const r of [fresh, stale, old]) await insertLog(db, r);
    const read = async (id: string) =>
      await t.call(`/developer/logs/${id}`, { headers: d.browser });
    const one = RequestLogDetailSchema.parse(await (await read(fresh.id)).json());
    expect(one).toMatchObject({
      hasBodies: true,
      requestBody: '{"a":1}',
      responseBody: '{"b":2}',
      bodiesExpireAt: fresh.at + LOG_BODY_MS,
    });
    // 25 hours old: the row is still there and still holds its body, but the read does not show it.
    expect(await countOf(`id = '${stale.id}' AND request_body IS NOT NULL`)).toBe(1);
    expect(RequestLogDetailSchema.parse(await (await read(stale.id)).json())).toMatchObject({
      hasBodies: false,
      requestBody: null,
      responseBody: null,
      bodiesExpireAt: null,
    });
    // 8 days old: gone from the read.
    await expectProblem(await read(old.id), 404, 'REQUEST_LOG_NOT_FOUND');
    const page = RequestLogPageSchema.parse(
      await (await t.call('/developer/logs', { headers: d.browser })).json(),
    );
    expect(page.items.map((i) => i.id)).toEqual([fresh.id, stale.id].sort().reverse());
    expect(page.items.find((i) => i.id === stale.id)?.hasBodies).toBe(false);
  });
});

describe('GET /developer/rail', () => {
  it('names the key, its scopes and tier, and counts the last hour of the sandbox', async () => {
    const d = await t.developer();
    for (let i = 0; i < 3; i++)
      await insertLog(
        t.kit.env.DB,
        entry(d.made.orgId, d.key.id, { at: t.kit.clock.now() - 10 * 60_000 }),
      );
    await insertLog(
      t.kit.env.DB,
      entry(d.made.orgId, d.key.id, { at: t.kit.clock.now() - 2 * HOUR }),
    );
    const rail = await (await t.call('/developer/rail', { headers: d.browser })).json();
    expect(rail).toMatchObject({
      mode: 'test',
      tier: 'standard',
      limitPerMinute: 600,
      callsLastHour: 3,
      key: { id: d.key.id },
    });
    expect((rail as { scopes: string[] }).scopes).toContain('passes:write');
    const { token } = await t.mint(d.browser);
    const viaToken = await (
      await t.call('/developer/rail', { headers: fromPage(d.browser, token) })
    ).json();
    expect(viaToken).toMatchObject({ key: { id: d.key.id }, callsLastHour: 3 });
  });
});

describe('the purges', () => {
  it('blanks bodies after 24 hours and deletes rows after 7 days, in every org', async () => {
    const a = await t.developer();
    const b = await t.developer();
    const db = t.kit.env.DB;
    const now = t.kit.clock.now();
    const rows = [a, b].flatMap((d) => [
      entry(d.made.orgId, d.key.id, { at: now - HOUR }),
      entry(d.made.orgId, d.key.id, { at: now - 2 * LOG_BODY_MS }),
      entry(d.made.orgId, d.key.id, { at: now - LOG_META_MS - HOUR }),
    ]);
    for (const r of rows) await insertLog(db, r);
    const ids = rows.map((r) => `'${r.id}'`).join(',');
    // Rows of the other tests are swept too, so the counts are at least this test's own.
    const swept = await purgeRequestLog(t.ctx());
    expect(swept.bodies).toBeGreaterThanOrEqual(4);
    expect(swept.rows).toBeGreaterThanOrEqual(2);
    expect(await countOf(`id IN (${ids})`)).toBe(4);
    expect(await countOf(`id IN (${ids}) AND has_bodies = 1 AND request_body IS NOT NULL`)).toBe(2);
    expect(
      await countOf(
        `id IN (${ids}) AND has_bodies = 0 AND request_body IS NULL AND response_body IS NULL`,
      ),
    ).toBe(2);
    // Metadata of the blanked rows is kept.
    expect(await countOf(`id IN (${ids}) AND status = 200 AND method = 'GET'`)).toBe(4);
    expect(await purgeRequestLog(t.ctx())).toEqual({ bodies: 0, rows: 0 });
    // A day and a bit later the rest follow.
    t.kit.clock.advance(LOG_BODY_MS + HOUR);
    expect((await purgeRequestLog(t.ctx())).bodies).toBeGreaterThanOrEqual(2);
  });

  it('runs from the minute cron every minute, until caught up', async () => {
    const d = await t.developer();
    const old = entry(d.made.orgId, d.key.id, { at: t.kit.clock.now() - 3 * LOG_BODY_MS });
    await insertLog(t.kit.env.DB, old);
    await minutelyRequestLogPurge(t.ctx());
    expect(await countOf(`id = '${old.id}' AND has_bodies = 1`)).toBe(0);
    await run(t.kit.env.DB, 'DELETE FROM request_log WHERE id = ?', [old.id]);
  });

  it('keeps up under 600 calls a minute: a backlog of 12,000 old rows goes in one run', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    const now = t.kit.clock.now();
    // 20 minutes of a sandbox at its 600 a minute tier, all past 24 hours and the older half past 7 days.
    await run(
      db,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
       INSERT INTO request_log (id, org_id, mode, request_id, method, path, status, duration_ms, at, has_bodies, request_body)
       SELECT 'bulk-' || i, ?1, 'test', 'r', 'GET', '/api/v1/passes', 200, 3, ?2 - CASE WHEN i % 2 = 0 THEN ?3 ELSE ?4 END - i, 1, '{}' FROM n`,
      [d.made.orgId, now, LOG_META_MS + HOUR, LOG_BODY_MS + HOUR],
    );
    expect(await countOf("id LIKE 'bulk-%' AND has_bodies = 1")).toBe(12_000);
    await minutelyRequestLogPurge(t.ctx());
    expect(await countOf("id LIKE 'bulk-%' AND has_bodies = 1")).toBe(0);
    expect(await countOf("id LIKE 'bulk-%'")).toBe(6000);
    // The budget follows the deletes.
    const budget = await first<{ total_rows: number }>(
      db,
      'SELECT total_rows FROM request_log_budget WHERE org_id = ?',
      [d.made.orgId],
    );
    expect(budget?.total_rows).toBe(6000);
  }, 60_000);

  it('stops at its time budget and carries on the next minute', async () => {
    const d = await t.developer();
    const db = t.kit.env.DB;
    for (let i = 0; i < 3; i++)
      await insertLog(
        db,
        entry(d.made.orgId, d.key.id, { at: t.kit.clock.now() - 3 * LOG_BODY_MS }),
      );
    expect((await purgeRequestLog(t.ctx(), 0)).bodies).toBe(0);
    expect((await purgeRequestLog(t.ctx())).bodies).toBeGreaterThanOrEqual(3);
  });
});
