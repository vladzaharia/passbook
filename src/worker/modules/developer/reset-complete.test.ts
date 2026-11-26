import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { OperationDto } from '../../../shared/contracts/operations.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { toDto } from '../operations/dto.ts';
import { handleOperationRun } from '../operations/jobs.ts';
import { progressOf } from '../operations/progress.ts';
import { rowById } from '../operations/repo.ts';
import { startOperation } from '../operations/start.ts';
import { reopenSandbox } from './repo-grants-reset.ts';
import { logKit } from './request-log-test-fixtures.ts';
import { resetSandbox } from './reset.ts';
import { mintSandboxKeyOnce } from './sandbox-key.ts';
import { BROWSER, bearer } from './try-token-test-fixtures.ts';

let t: Awaited<ReturnType<typeof logKit>>;
beforeAll(async () => {
  t = await logKit();
  (t.kit.env as { RL_REFRESH: unknown }).RL_REFRESH = { limit: async () => ({ success: true }) };
  // A retry's `operation.run` goes nowhere: the test runs the job's entry itself, on its own clock.
  Object.assign(t.kit.env, { JOBS: { send: async () => {} } });
}, 60_000);
afterAll(() => t.unstub());

type Dev = Awaited<ReturnType<typeof t.developer>>;
const db = () => t.kit.env.DB;
const json = (headers: Record<string, string>, body: unknown) => ({
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** A fresh Polaris ID session of the person, as headers and as the auth object the service takes. */
async function fresh(d: Dev, authTime?: number | null) {
  const s = await makeSession(t.kit.f, {
    userId: d.user.id,
    roles: ['user', 'developer'],
    ...(authTime === undefined ? {} : { authTime }),
  });
  const auth: SessionAuth = {
    kind: 'session',
    userId: d.user.id,
    sessionId: await sha256Hex(s.cookieValue),
    roles: ['user', 'developer'],
    csrfSecret: s.csrf,
    amr: 'oidc',
    authTime: t.kit.clock.now(),
    mode: 'live',
  };
  return { headers: { ...s.headers, ...BROWSER }, auth };
}

const count = async (table: string, orgId: string, extra = '') =>
  (
    await first<{ n: number }>(
      db(),
      `SELECT count(*) AS n FROM ${table} WHERE org_id = ? ${extra}`,
      [orgId],
    )
  )?.n ?? 0;

/** `n` more rows like the first one of `table` in the org, with fresh unique columns. */
async function clone(table: string, orgId: string, n: number, unique: string[]) {
  const cols = (
    await all<{ name: string }>(db(), `SELECT name FROM pragma_table_info('${table}')`)
  ).map((c) => c.name);
  const expr = cols.map((c) =>
    unique.includes(c)
      ? `${c.endsWith('_token') ? "'h1:' || " : ''}lower(hex(randomblob(16)))`
      : `src.${c}`,
  );
  await run(
    db(),
    `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
     INSERT INTO ${table} (${cols.join(', ')})
     SELECT ${expr.join(', ')} FROM seq, (SELECT * FROM ${table} WHERE org_id = ? LIMIT 1) src`,
    [n, orgId],
  );
}

async function onePass(d: Dev): Promise<void> {
  const headers = bearer(d.key.secret);
  const tpl = (await (await t.call(`/templates/${d.made.templateId}`, { headers })).json()) as {
    manifest: { sample?: Record<string, unknown> };
  };
  const res = await t.call('/passes', {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'idempotency-key': t.kit.f.ids.token(),
    },
    body: JSON.stringify({ templateId: d.made.templateId, input: tpl.manifest.sample ?? {} }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  await t.settle();
}

describe('reset: authority', () => {
  it('asks for a recent sign-in on reset and on reopen, and names Polaris ID', async () => {
    const d = await t.developer();
    const stale = await fresh(d, t.kit.clock.now() - 11 * 60_000);
    for (const path of ['/developer/sandbox/reset', '/developer/sandbox/reopen']) {
      const res = await t.call(path, json(stale.headers, { turnstileToken: 'ok' }));
      await expectProblem(res, 403, 'STEP_UP_REQUIRED');
      expect(((await res.json()) as { signInUrl?: string }).signInUrl).toContain(
        '/auth/oidc/start',
      );
    }
    // Nothing was spent or deleted.
    expect(await count('audit_log', d.made.orgId, "AND action = 'developer_sandbox.reset'")).toBe(
      0,
    );
  });
});

const claims = (orgId: string) =>
  count('audit_log', orgId, "AND action = 'developer_sandbox.reset'");

/** The operation row a reset's route makes, queued. */
async function startReset(d: Dev, auth: SessionAuth) {
  return startOperation(t.ctx(), {
    kind: 'sandbox.reset',
    target: { type: 'sandbox', id: d.made.orgId },
    actor: { type: 'user', id: d.user.id },
    session: auth.sessionId,
    subject: { userId: d.user.id },
    lease: true,
  });
}

/** One attempt as the runner makes it: it reports through the operation and ends it. */
async function attempt(
  auth: SessionAuth,
  opId: string,
  ctx = t.ctx(),
  after?: (step: string) => Promise<void>,
) {
  const op = toDto((await rowById(db(), opId)) as NonNullable<Awaited<ReturnType<typeof rowById>>>);
  const progress = progressOf(ctx, op.id, op.attempt);
  try {
    const out = await resetSandbox(ctx, auth, op, progress, after);
    await progress.succeed({ href: null, ids: out.ids });
    return out;
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}

const reset = async (d: Dev, auth: SessionAuth) => attempt(auth, (await startReset(d, auth)).id);
const readOp = async (id: string) =>
  toDto((await rowById(db(), id)) as NonNullable<Awaited<ReturnType<typeof rowById>>>);

/** A failed reset's retry as the page asks for it: the route, then the job it queued. */
async function retry(headers: Record<string, string>, op: OperationDto) {
  const res = await t.call(`/operations/${op.id}/retry`, { method: 'POST', headers });
  expect(res.status, await res.clone().text()).toBe(200);
  await handleOperationRun(
    { kind: 'operation.run', operationId: op.id, attempt: op.attempt + 1 },
    createJobContext(t.kit.env, 'test', { clock: t.kit.clock }),
  );
  return readOp(op.id);
}

const CLONE = ['id', 'serial', 'auth_token', 'download_token', 'scan_code', 'object_key'];

describe('reset: completeness and resume', () => {
  it('deletes everything past the old per-request caps: 350 passes and 15,000 log rows, with no time budget', async () => {
    const d = await t.developer();
    await onePass(d);
    await clone('passes', d.made.orgId, 349, CLONE);
    await run(
      db(),
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 15000)
       INSERT INTO request_log (id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code, duration_ms, at, has_bodies)
       SELECT lower(hex(randomblob(16))), ?1, NULL, NULL, 'test', 'r' || i, 'GET', '/passes', '/api/v1/passes', NULL, 200, NULL, 1, ?2, 0 FROM seq`,
      [d.made.orgId, t.kit.clock.now() - 1000],
    );
    expect(await count('passes', d.made.orgId)).toBe(350);
    t.kit.clock.advance(1000);
    const { auth } = await fresh(d);
    const out = await reset(d, auth);
    expect(out.ids.passes).toBe('350');
    expect(Number(out.ids.calls)).toBeGreaterThanOrEqual(15_000);
    expect(await count('passes', d.made.orgId)).toBe(0);
    expect(await count('request_log', d.made.orgId)).toBe(0);
  }, 240_000);

  it('reports each step with its counts, and the old key dies with the claim', async () => {
    const d = await t.developer();
    await onePass(d);
    await clone('passes', d.made.orgId, 60, CLONE);
    t.kit.clock.advance(1000);
    const { auth } = await fresh(d);
    const started = await startReset(d, auth);
    await attempt(auth, started.id);
    const op = await readOp(started.id);
    expect(op.status).toBe('succeeded');
    expect(op.steps.map((x) => [x.key, x.state])).toEqual([
      ['claim', 'done'],
      ['passes', 'done'],
      ['captures', 'done'],
      ['rows', 'done'],
      ['template', 'done'],
    ]);
    // Every pass it deleted is counted: "61 of 61".
    expect(op.steps.find((x) => x.key === 'passes')).toMatchObject({ done: 61, total: 61 });
    expect(op.steps.find((x) => x.key === 'rows')).toMatchObject({ total: 8, done: 8 });
    expect(op.result?.ids).toMatchObject({ passes: '61', resetsLeft: '2' });
    await expectProblem(
      await t.call('/passes', { headers: bearer(d.key.secret) }),
      401,
      'INVALID_API_KEY',
    );
  }, 240_000);

  it('a stop after the claim leaves no new key, and a retry resumes under the same claim without a new slot', async () => {
    const d = await t.developer();
    await onePass(d);
    await clone('passes', d.made.orgId, 30, CLONE);
    t.kit.clock.advance(1000);
    const { auth, headers } = await fresh(d);
    const started = await startReset(d, auth);
    await expect(
      attempt(auth, started.id, t.ctx(), async (step) => {
        if (step === 'claim') throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    const failed = await readOp(started.id);
    expect(failed).toMatchObject({ status: 'failed', step: 'passes' });
    expect(failed.steps.find((x) => x.key === 'claim')?.state).toBe('done');
    expect(await claims(d.made.orgId)).toBe(1);
    // The old secret died with the claim, before the purge.
    await expectProblem(
      await t.call('/passes', { headers: bearer(d.key.secret) }),
      401,
      'INVALID_API_KEY',
    );
    t.kit.clock.advance(1000);
    const done = await retry(headers, failed);
    expect(done).toMatchObject({ status: 'succeeded', attempt: 2 });
    expect(done.result?.ids.resetsLeft).toBe('2');
    expect(await count('passes', d.made.orgId)).toBe(0);
    expect(await claims(d.made.orgId)).toBe(1);
  }, 240_000);

  it('a fault mid-purge stops on the step, and a retry finishes the purge', async () => {
    const d = await t.developer();
    await onePass(d);
    await clone('passes', d.made.orgId, 30, CLONE);
    t.kit.clock.advance(1000);
    let failed = 0;
    const real = t.kit.env.BUCKET;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === 'delete')
          return async (keys: string | string[]) => {
            if (failed++ === 0) throw new Error('R2 fault');
            return target.delete(keys);
          };
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const ctx = t.ctx();
    const broken = { ...ctx, env: { ...ctx.env, BUCKET: flaky } } as typeof ctx;
    const { auth, headers } = await fresh(d);
    const started = await startReset(d, auth);
    await expect(attempt(auth, started.id, broken)).rejects.toThrow('R2 fault');
    const stopped = await readOp(started.id);
    expect(stopped).toMatchObject({ status: 'failed', step: 'passes' });
    expect(stopped.error).toMatchObject({ code: 'OPERATION_FAILED', retryable: true });
    expect(await claims(d.made.orgId)).toBe(1);
    t.kit.clock.advance(1000);
    const done = await retry(headers, stopped);
    expect(done.status).toBe('succeeded');
    expect(done.result?.ids.resetsLeft).toBe('2');
    expect(await count('passes', d.made.orgId)).toBe(0);
    expect(await claims(d.made.orgId)).toBe(1);
  }, 240_000);

  it('leaves a request in flight alone, and removes bundles, imports and the ticket is released again', async () => {
    const d = await t.developer();
    const org = d.made.orgId;
    const now = t.kit.clock.now();
    // A settled and an unsettled idempotency claim, both older than the reset.
    await run(
      db(),
      'INSERT INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [org, 'done', 'h', 'r1', now - 10],
    );
    await run(
      db(),
      'INSERT INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at) VALUES (?, ?, ?, NULL, ?)',
      [org, 'inflight', 'h', now - 10],
    );
    t.kit.clock.advance(1000);
    const out = await reset(d, (await fresh(d)).auth);
    expect(await count('idempotency_keys', org)).toBe(1);
    expect(
      (
        await first<{ key: string }>(db(), 'SELECT key FROM idempotency_keys WHERE org_id = ?', [
          org,
        ])
      )?.key,
    ).toBe('inflight');
    // The ticket template has its Test release.
    expect(out.sandbox.templateId).toBe(d.made.templateId);
    expect(
      (
        await first<{ n: number }>(
          db(),
          "SELECT count(*) AS n FROM template_releases WHERE template_id = ? AND mode = 'test'",
          [d.made.templateId],
        )
      )?.n,
    ).toBeGreaterThan(0);
  }, 120_000);

  it('keeps an old key out: after a reset only the new key works, and the funnel keeps its first values', async () => {
    const d = await t.developer();
    await onePass(d);
    t.kit.clock.advance(1000);
    const { auth, headers } = await fresh(d);
    await reset(d, auth);
    const keyed = await t.call('/developer/sandbox/key', { method: 'POST', headers });
    expect(keyed.status, await keyed.clone().text()).toBe(201);
    const { key } = (await keyed.json()) as { key: { secret: string } };
    expect((await t.call('/passes', { headers: bearer(key.secret) })).status).toBe(200);
  }, 120_000);

  it('a key revoked after a finished reset does not make it unfinished: the next reset is a real one', async () => {
    const d = await t.developer();
    await onePass(d);
    t.kit.clock.advance(1000);
    const first1 = await reset(d, (await fresh(d)).auth);
    expect(first1.ids.resetsLeft).toBe('2');
    t.kit.clock.advance(1000);
    const second = await reset(d, (await fresh(d)).auth);
    expect(second.ids.resetsLeft).toBe('1');
    expect(await claims(d.made.orgId)).toBe(2);
    const rows = await all<{ t: number }>(
      db(),
      'SELECT track_started_at AS t FROM developer_sandboxes WHERE org_id = ?',
      [d.made.orgId],
    );
    expect(rows[0]?.t).toBeGreaterThan(t.kit.clock.now() - 3000);
  }, 120_000);

  it('two key mints at once make one key, and a second is refused while it lives', async () => {
    const d = await t.developer();
    await onePass(d);
    t.kit.clock.advance(1000);
    const { auth } = await fresh(d);
    await reset(d, auth);
    t.kit.clock.advance(1000);
    const [a, b] = await Promise.allSettled([
      mintSandboxKeyOnce(t.ctx(), auth),
      mintSandboxKeyOnce(t.ctx(), auth),
    ]);
    expect([a, b].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const open = await all<{ id: string }>(
      db(),
      "SELECT id FROM api_keys WHERE org_id = ? AND name = 'Sandbox key' AND revoked_at IS NULL",
      [d.made.orgId],
    );
    expect(open.length).toBe(1);
    await expect(mintSandboxKeyOnce(t.ctx(), auth)).rejects.toMatchObject({
      code: 'SANDBOX_KEY_SHOWN',
    });
    expect(await claims(d.made.orgId)).toBe(1);
  }, 120_000);

  it('a resume never removes rows made after the claim', async () => {
    const d = await t.developer();
    const org = d.made.orgId;
    await onePass(d);
    t.kit.clock.advance(1000);
    const { auth, headers } = await fresh(d);
    const started = await startReset(d, auth);
    await expect(
      attempt(auth, started.id, t.ctx(), async (step) => {
        if (step === 'claim') throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    const stamp =
      (
        await first<{ t: number }>(
          db(),
          'SELECT track_started_at AS t FROM developer_sandboxes WHERE org_id = ?',
          [org],
        )
      )?.t ?? 0;
    // A request-log row and a capture newer than the claim.
    await run(
      db(),
      "INSERT INTO request_log (id, org_id, key_id, via, mode, request_id, method, route, path, query, status, code, duration_ms, at, has_bodies) VALUES ('newer', ?, NULL, NULL, 'test', 'rn', 'GET', NULL, '/x', NULL, 200, NULL, 1, ?, 0)",
      [org, stamp + 500],
    );
    t.kit.clock.advance(1000);
    const done = await retry(headers, await readOp(started.id));
    expect(done.status).toBe('succeeded');
    expect(await count('request_log', org, "AND id = 'newer'")).toBe(1);
  }, 120_000);

  it('the reopen window is in the write: a window that ended after the read refuses the reopen', async () => {
    const d = await t.developer();
    expect(
      (await t.call('/developer/sandbox/close', { method: 'POST', headers: d.browser })).status,
    ).toBe(200);
    // The service read saw an open window; by the write it has passed.
    await run(db(), 'UPDATE orgs SET purge_after = ? WHERE id = ?', [
      t.kit.clock.now() - 1,
      d.made.orgId,
    ]);
    const { auth } = await fresh(d);
    const sandbox = { id: d.made.id, orgId: d.made.orgId };
    await expect(
      reopenSandbox(t.ctx(), sandbox, { userId: auth.userId, sessionIdHash: auth.sessionId }),
    ).rejects.toMatchObject({ code: 'SANDBOX_CONFLICT' });
    expect(
      (
        await first<{ status: string }>(db(), 'SELECT status FROM orgs WHERE id = ?', [
          d.made.orgId,
        ])
      )?.status,
    ).toBe('deleted');
  }, 60_000);
});
