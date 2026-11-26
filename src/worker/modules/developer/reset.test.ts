import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import {
  CreatedDeveloperSandboxSchema,
  RequestLogPageSchema,
  SandboxKeyResponseSchema,
} from '../../../shared/contracts/index.ts';
import { OperationSchema } from '../../../shared/contracts/operations.ts';
import { all, first, run } from '../../platform/db.ts';
import { deleteSlice, RESET_TABLES, type ResetTable } from './repo-reset.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { BROWSER, bearer } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
  // The per-minute limiter is real time; the daily limit under test counts by the test clock.
  (t.kit.env as { RL_REFRESH: unknown }).RL_REFRESH = { limit: async () => ({ success: true }) };
});
afterAll(() => t.unstub());

type Dev = Awaited<ReturnType<typeof t.developer>>;
const DAY = 86_400_000;
const db = () => t.kit.env.DB;

/** Every table a reset empties, deleted for `orgId` under a claimed `(person, stamp)`; the rows it removed. */
async function sweep(orgId: string, userId: string, stamp: number): Promise<number> {
  let total = 0;
  for (const table of Object.keys(RESET_TABLES) as ResetTable[])
    total += await deleteSlice(db(), table, orgId, userId, stamp);
  return total;
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

async function makePass(d: Dev, key = d.key.secret): Promise<string> {
  const headers = bearer(key);
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

async function capture(d: Dev) {
  const eps = (await (
    await t.call('/webhook-endpoints', { headers: bearer(d.key.secret) })
  ).json()) as { items: { id: string; target: string }[] };
  const ep = eps.items.find((e) => e.target === 'capture');
  const res = await t.call(
    `/webhook-endpoints/${ep?.id}/test`,
    json(bearer(d.key.secret), 'POST', { type: 'webhook.test' }),
  );
  expect(res.status, await res.clone().text()).toBe(200);
  await t.settle();
}

/** A fresh session each time: a day of test clock outlives one. */
const reset = async (d: Dev, body: unknown = { turnstileToken: 'ok' }) => {
  const s = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user', 'developer'] });
  return t.call('/developer/sandbox/reset', json({ ...s.headers, ...BROWSER }, 'POST', body));
};

/** A reset the page's way: the operation, waited for, and then the new key minted once. */
async function resetDone(d: Dev) {
  const s = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user', 'developer'] });
  const headers = { ...s.headers, ...BROWSER };
  const res = await t.call(
    '/developer/sandbox/reset',
    json(headers, 'POST', { turnstileToken: 'ok' }),
  );
  expect(res.status, await res.clone().text()).toBe(202);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const started = OperationSchema.parse(((await res.json()) as { operation: unknown }).operation);
  await t.settle();
  const op = OperationSchema.parse(
    await (await t.call(`/operations/${started.id}`, { headers })).json(),
  );
  expect(op.status, JSON.stringify(op.error)).toBe('succeeded');
  const ids = op.result?.ids ?? {};
  const keyed = await t.call('/developer/sandbox/key', { method: 'POST', headers });
  expect(keyed.status, await keyed.clone().text()).toBe(201);
  const { key } = SandboxKeyResponseSchema.parse(await keyed.json());
  return {
    op,
    key,
    deleted: {
      passes: Number(ids.passes),
      captures: Number(ids.captures),
      calls: Number(ids.calls),
    },
    kept: Number(ids.kept),
    resetsLeft: Number(ids.resetsLeft),
  };
}

const count = async (table: string, orgId: string) =>
  (await first<{ n: number }>(db(), `SELECT count(*) AS n FROM ${table} WHERE org_id = ?`, [orgId]))
    ?.n ?? 0;

/** Everything a reset must leave alone. */
const kept = async (orgId: string) => ({
  org: await first(db(), 'SELECT status, kind FROM orgs WHERE id = ?', [orgId]),
  templates: await count('templates', orgId),
  members: await count('org_memberships', orgId),
  endpoints: await count('webhook_endpoints', orgId),
  sandbox: await first(
    db(),
    'SELECT first_call_at, first_pass_at, first_key_call_at, first_change_at, first_webhook_at, closed_at FROM developer_sandboxes WHERE org_id = ?',
    [orgId],
  ),
});

describe('POST /developer/sandbox/reset', () => {
  it('deletes the sandbox test data, restarts the track, replaces the key and keeps the rest', async () => {
    const d = await t.developer();
    await makePass(d);
    await makePass(d);
    await capture(d);
    const orgId = d.made.orgId;
    expect(await count('passes', orgId)).toBe(2);
    expect(await count('webhook_captures', orgId)).toBeGreaterThan(0);
    expect(await count('request_log', orgId)).toBeGreaterThan(0);
    const before = await kept(orgId);
    t.kit.clock.advance(60_000);
    const body = await resetDone(d);
    expect(body.deleted.passes).toBe(2);
    expect(body.deleted.captures).toBeGreaterThan(0);
    expect(body.deleted.calls).toBeGreaterThan(0);
    expect(body.kept).toBe(0);
    expect(body.resetsLeft).toBe(2);
    expect(body.key.secret).toMatch(/^pbp_test_/);
    expect(body.key.id).not.toBe(d.key.id);
    expect(await count('passes', orgId)).toBe(0);
    expect(await count('webhook_captures', orgId)).toBe(0);
    expect(await count('request_log', orgId)).toBe(0);
    expect(await count('idempotent_requests', orgId)).toBe(0);
    expect(await kept(orgId)).toEqual(before);
    // The old key is revoked; the new one works.
    await expectProblem(
      await t.call('/passes', { headers: bearer(d.key.secret) }),
      401,
      'INVALID_API_KEY',
    );
    expect((await t.call('/passes', { headers: bearer(body.key.secret) })).status).toBe(200);
    // The track restarts, the funnel's first values stay.
    const home = (await (await t.call('/developer/home', { headers: d.browser })).json()) as {
      progress: { next: string; passAt: number | null; restartedAt: number | null };
    };
    expect(home.progress).toMatchObject({ next: 'call', passAt: null });
    expect(home.progress.restartedAt).not.toBeNull();
    const audit = await all<{ action: string; actor_id: string }>(
      db(),
      "SELECT action, actor_id FROM audit_log WHERE org_id = ? AND action = 'developer_sandbox.reset'",
      [orgId],
    );
    expect(audit).toEqual([{ action: 'developer_sandbox.reset', actor_id: d.user.id }]);
  });

  it('is idempotent: a second reset finds nothing and leaves the same state', async () => {
    const d = await t.developer();
    await makePass(d);
    await resetDone(d);
    const after = await kept(d.made.orgId);
    const again = await resetDone(d);
    expect(again.deleted).toMatchObject({ passes: 0, captures: 0 });
    expect(again.resetsLeft).toBe(1);
    expect(await kept(d.made.orgId)).toEqual(after);
    expect(await count('passes', d.made.orgId)).toBe(0);
  });

  it('never touches another sandbox or a real organization', async () => {
    const a = await t.developer();
    const b = await t.developer();
    await makePass(a);
    await makePass(b);
    await capture(b);
    const real = await makeOrg(t.kit.f, { name: 'Real Co' });
    await run(
      db(),
      'INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)',
      [real.id, 'k1', 'h', t.kit.clock.now()],
    );
    const snapshot = async () => ({
      b: {
        passes: await count('passes', b.made.orgId),
        captures: await count('webhook_captures', b.made.orgId),
        log: await count('request_log', b.made.orgId),
        kept: await kept(b.made.orgId),
      },
      real: await count('idempotency_keys', real.id),
    });
    const before = await snapshot();
    await resetDone(a);
    expect(await snapshot()).toEqual(before);
    expect(await count('passes', a.made.orgId)).toBe(0);
  });

  it('the guarded deletes refuse a stale claim, a foreign person and a non-sandbox org', async () => {
    const d = await t.developer();
    await makePass(d);
    const orgId = d.made.orgId;
    const rows = await count('request_log', orgId);
    expect(rows).toBeGreaterThan(0);
    const stamp = (
      await first<{ t: number | null }>(
        db(),
        'SELECT track_started_at AS t FROM developer_sandboxes WHERE org_id = ?',
        [orgId],
      )
    )?.t;
    // No claim yet (the track never restarted): the stamp is null, so nothing matches.
    expect(await sweep(orgId, d.user.id, t.kit.clock.now())).toBe(0);
    expect(stamp).toBeNull();
    expect(await count('request_log', orgId)).toBe(rows);
    // A real org has no developer sandbox, so no claim can stand.
    const real = await makeOrg(t.kit.f, { name: 'Real Co 2' });
    await run(
      db(),
      'INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)',
      [real.id, 'k2', 'h', t.kit.clock.now()],
    );
    await sweep(real.id, d.user.id, 1);
    expect(await count('idempotency_keys', real.id)).toBe(1);
    // After a real claim, a different person or an older stamp still deletes nothing.
    t.kit.clock.advance(1000);
    await resetDone(d);
    const claimed = (
      await first<{ t: number }>(
        db(),
        'SELECT track_started_at AS t FROM developer_sandboxes WHERE org_id = ?',
        [orgId],
      )
    )?.t as number;
    const other = await makeUser(t.kit.f);
    expect(await sweep(orgId, other.id, claimed)).toBe(0);
    expect(await sweep(orgId, d.user.id, claimed - 1)).toBe(0);
  });

  it('allows 3 a day, refuses the 4th without deleting anything, and the day rolls', async () => {
    const d = await t.developer();
    let key = d.key.secret;
    for (let i = 0; i < 3; i++) {
      t.kit.clock.advance(1000);
      key = (await resetDone(d)).key.secret;
    }
    const freshKey = async () => key;
    await makePass(d, await freshKey());
    const left = await count('passes', d.made.orgId);
    expect(left).toBe(1);
    t.kit.clock.advance(1000);
    const fourth = await reset(d);
    await expectProblem(fourth, 429, 'SANDBOX_RESET_LIMIT');
    expect(await count('passes', d.made.orgId)).toBe(left);
    t.kit.clock.advance(DAY);
    const next = await resetDone(d);
    expect(next.deleted.passes).toBe(1);
    expect(next.resetsLeft).toBe(2);
  });

  it('refuses a closed sandbox, a missing one, a failed check, a plain user and a key', async () => {
    const d = await t.developer();
    expect(
      (await t.call('/developer/sandbox/close', { method: 'POST', headers: d.browser })).status,
    ).toBe(200);
    await expectProblem(await reset(d), 409, 'SANDBOX_CLOSED');
    const nobody = await makeSession(t.kit.f, {
      userId: (await makeUser(t.kit.f)).id,
      roles: ['user', 'developer'],
    });
    await expectProblem(
      await t.call(
        '/developer/sandbox/reset',
        json({ ...nobody.headers, ...BROWSER }, 'POST', { turnstileToken: 'ok' }),
      ),
      404,
      'SANDBOX_NOT_FOUND',
    );
    const plain = await makeSession(t.kit.f, { userId: (await makeUser(t.kit.f)).id });
    await expectProblem(
      await t.call(
        '/developer/sandbox/reset',
        json({ ...plain.headers, ...BROWSER }, 'POST', { turnstileToken: 'ok' }),
      ),
      403,
      'DEVELOPER_ACCESS_REQUIRED',
    );
    const e = await t.developer();
    await expectProblem(
      await t.call(
        '/developer/sandbox/reset',
        json(bearer(e.key.secret), 'POST', { turnstileToken: 'ok' }),
      ),
      401,
      'UNAUTHENTICATED',
    );
    expect(CreatedDeveloperSandboxSchema).toBeDefined();
  });
});

describe('POST /developer/sandbox/reopen', () => {
  /** A fresh session: the window is days long and a session is not. */
  const reopen = async (d: Dev) => {
    const s = await makeSession(t.kit.f, { userId: d.user.id, roles: ['user', 'developer'] });
    return t.call('/developer/sandbox/reopen', {
      method: 'POST',
      headers: { ...s.headers, ...BROWSER },
    });
  };
  const close = (d: Dev) =>
    t.call('/developer/sandbox/close', { method: 'POST', headers: d.browser });

  it('reopens its own close inside the window, with a new key, and the data is as it was', async () => {
    const d = await t.developer();
    await makePass(d);
    await close(d);
    t.kit.clock.advance(5 * DAY);
    const res = await reopen(d);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = CreatedDeveloperSandboxSchema.parse(await res.json());
    expect(body.closedAt).toBeNull();
    expect(body.key?.secret).toMatch(/^pbp_test_/);
    expect(await count('passes', d.made.orgId)).toBe(1);
    expect((await t.call('/passes', { headers: bearer(body.key?.secret ?? '') })).status).toBe(200);
    expect(
      await first(db(), 'SELECT status, closed_at, purge_after FROM orgs WHERE id = ?', [
        d.made.orgId,
      ]),
    ).toEqual({
      status: 'active',
      closed_at: null,
      purge_after: null,
    });
  });

  it('refuses an open sandbox, a passed window, an administrator close, and another person', async () => {
    const open = await t.developer();
    await expectProblem(await reopen(open), 409, 'SANDBOX_NOT_CLOSED');
    const late = await t.developer();
    await close(late);
    t.kit.clock.advance(31 * DAY);
    await expectProblem(await reopen(late), 409, 'SANDBOX_REOPEN_WINDOW');
    // An administrator's close: the sandbox record says so, and the person cannot undo it.
    const adminUser = await makeUser(t.kit.f);
    const adminOrg = await makeOrg(t.kit.f, { kind: 'developer' });
    const now = t.kit.clock.now();
    await run(
      db(),
      "INSERT INTO developer_sandboxes (id, org_id, user_id, created_at, closed_at, close_reason) VALUES (?, ?, ?, ?, ?, 'admin')",
      [t.kit.f.ids.id(), adminOrg.id, adminUser.id, now - DAY, now],
    );
    await run(
      db(),
      "UPDATE orgs SET status = 'deleted', closed_at = ?, purge_after = ? WHERE id = ?",
      [now, now + 30 * DAY, adminOrg.id],
    );
    const adminSession = await makeSession(t.kit.f, {
      userId: adminUser.id,
      roles: ['user', 'developer'],
    });
    await expectProblem(
      await t.call('/developer/sandbox/reopen', {
        method: 'POST',
        headers: { ...adminSession.headers, ...BROWSER },
      }),
      409,
      'SANDBOX_REOPEN_ADMIN',
    );
    const other = await makeSession(t.kit.f, {
      userId: (await makeUser(t.kit.f)).id,
      roles: ['user', 'developer'],
    });
    await expectProblem(
      await t.call('/developer/sandbox/reopen', {
        method: 'POST',
        headers: { ...other.headers, ...BROWSER },
      }),
      404,
      'SANDBOX_NOT_FOUND',
    );
  });
});

describe('the request log client', () => {
  it('stores a short normalised client, never the header, and the log lists it', async () => {
    const d = await t.developer();
    await t.call('/passes', { headers: { ...bearer(d.key.secret), 'user-agent': 'curl/8.7.1' } });
    await t.call('/passes', {
      headers: { ...bearer(d.key.secret), 'user-agent': 'secret-tool/9 alice@example.com' },
    });
    await t.settle();
    const rows = await t.rows(d.made.orgId);
    const clients = rows.map((r) => r.client);
    expect(clients).toContain('curl/8.7.1');
    expect(JSON.stringify(rows)).not.toContain('alice@example.com');
    expect(JSON.stringify(rows)).not.toContain('secret-tool');
    const page = RequestLogPageSchema.parse(
      await (await t.call('/developer/logs?source=key', { headers: d.browser })).json(),
    );
    expect(page.items.map((i) => i.client)).toContain('curl/8.7.1');
  });
});
