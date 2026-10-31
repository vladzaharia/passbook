import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearOidcCache } from './checks.ts';
import { clearStatusCache, getStatus, recordCronRun } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;

const okFetch = (async () =>
  new Response(JSON.stringify({ issuer: 'https://id.test' }))) as unknown as typeof fetch;
const badFetch = (async () => {
  throw new Error('down');
}) as unknown as typeof fetch;

const queue = (backlog: number, ageMs = 0) =>
  ({
    metrics: async () => ({
      backlogCount: backlog,
      backlogBytes: 0,
      oldestMessageTimestamp: ageMs ? new Date(Date.now() - ageMs) : undefined,
    }),
  }) as unknown as Queue;

const find = (status: Awaited<ReturnType<typeof getStatus>>, id: string) =>
  status.components.find((c) => c.id === id);

beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(async () => {
  clearStatusCache(env.DB);
  clearOidcCache();
  await run(env.DB, 'DELETE FROM workflow_runs');
  await run(env.DB, 'DELETE FROM connections');
  await run(env.DB, "DELETE FROM settings WHERE scope = 'system'");
});

async function status(
  overrides: Partial<AppEnv> = {},
  fetchImpl = okFetch,
  clock = new ManualClock(Date.now()),
) {
  const e = { ...base, ...overrides } as AppEnv;
  return getStatus(createServiceContext(e, { clock }), { fetch: fetchImpl });
}

describe('status components', () => {
  it('verifies D1 and R2, reports the build and sorts by severity', async () => {
    const fx = fixtures(base);
    const org = await makeOrg(fx);
    const now = Date.now();
    for (let i = 0; i < 5; i++)
      await run(
        env.DB,
        "INSERT INTO workflow_runs (instance_id, kind, org_id, status, started_at, error_code) VALUES (?, 'bulk_reissue', ?, 'errored', ?, 'X')",
        [`wf-${i}`, org.id, now - 1000 * i],
      );
    const s = await status({ JOBS: queue(5) } as Partial<AppEnv>, okFetch, new ManualClock(now));
    expect(find(s, 'database')?.state).toBe('verified');
    expect(find(s, 'storage')?.state).toBe('verified');
    expect(find(s, 'workflows')).toMatchObject({ state: 'failing', data: { errored: 5 } });
    expect(find(s, 'oidc')?.state).toBe('verified');
    expect(find(s, 'build')?.data?.id).toBe(base.CF_VERSION?.id ?? null);

    const rank = { failing: 0, degraded: 1, not_configured: 2, configured: 3, verified: 4 };
    const ranks = s.components.map((c) => rank[c.state]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(s.components[0]?.state).toBe('failing');
    expect(s.overall).toBe('failing');
  });

  it('ignores old workflow failures and reports configured when nothing ran', async () => {
    const now = Date.now();
    await run(
      env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, status, started_at) VALUES ('old', 'bulk_reissue', 'errored', ?)",
      [now - 3 * 86_400_000],
    );
    const s = await status({}, okFetch, new ManualClock(now));
    expect(find(s, 'workflows')).toMatchObject({ state: 'configured', detail: 'No runs.' });
  });

  it('degrades on one failed workflow and on queue backlog or dead letters', async () => {
    const now = Date.now();
    await run(
      env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, status, started_at) VALUES ('e1', 'template_import', 'errored', ?)",
      [now],
    );
    const s = await status(
      { JOBS: queue(2000), JOBS_DLQ: queue(3) } as unknown as Partial<AppEnv>,
      okFetch,
      new ManualClock(now),
    );
    expect(find(s, 'workflows')?.state).toBe('degraded');
    expect(find(s, 'queue')).toMatchObject({ state: 'degraded', data: { backlog: 2000, dlq: 3 } });
  });

  it('does not count rejected template uploads as workflow failures', async () => {
    const now = Date.now();
    await run(
      env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, status, started_at, error_code) VALUES ('r1', 'template_import', 'errored', ?, 'IMPORT_INVALID')",
      [now],
    );
    const s = await status({}, okFetch, new ManualClock(now));
    expect(find(s, 'workflows')).toMatchObject({ state: 'verified', data: { errored: 0, total: 1 } });
  });

  it('says so when queue metrics or the DLQ binding are unavailable', async () => {
    const s = await status({ JOBS: {} as Queue });
    expect(find(s, 'queue')).toMatchObject({
      state: 'configured',
      detail: 'Queue metrics unavailable.',
    });
    clearStatusCache(env.DB);
    const t = await status({ JOBS: queue(0), JOBS_DLQ: undefined } as unknown as Partial<AppEnv>);
    expect(find(t, 'queue')).toMatchObject({ state: 'verified', data: { dlq: null } });
    expect(find(t, 'queue')?.detail).toContain('Dead-letter depth unavailable');
  });

  it('flags email and the issuer honestly', async () => {
    const s = await status({ EMAIL: undefined } as unknown as Partial<AppEnv>, badFetch);
    expect(find(s, 'email')?.state).toBe('not_configured');
    expect(find(s, 'oidc')).toMatchObject({ state: 'degraded', detail: 'Discovery unreachable.' });
    clearStatusCache(env.DB);
    const t = await status({ OIDC_ISSUER: '' });
    expect(find(t, 'oidc')?.state).toBe('not_configured');
  });

  it('caches oidc discovery and the whole status briefly', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ issuer: 'x' }));
    }) as unknown as typeof fetch;
    const clock = new ManualClock(Date.now());
    await status({}, counting, clock);
    await status({}, counting, clock);
    clock.advance(20_000);
    await status({}, counting, clock);
    expect(calls).toBe(1);
    clock.advance(5 * 60_000);
    await status({}, counting, clock);
    expect(calls).toBe(2);
  });

  it('reports identities: expiring cert is degraded, a missing binding is degraded', async () => {
    const s = await status();
    const platform = find(s, 'identity:platform');
    expect(platform?.state).toBe('degraded');
    expect(platform?.detail).toMatch(/Expires in/);
    expect(platform?.data).toMatchObject({ source: 'env', bindingPresent: false });

    await run(
      env.DB,
      "UPDATE signing_identities SET apns_binding = 'APNS_GONE' WHERE id = 'platform'",
    );
    clearStatusCache(env.DB);
    const t = await status();
    expect(find(t, 'identity:platform')?.detail).toContain('APNS_GONE is missing');

    clearStatusCache(env.DB);
    const expired = await status({}, okFetch, new ManualClock(Date.now() + 30 * 86_400_000));
    expect(find(expired, 'identity:platform')?.state).toBe('failing');
  });

  it('summarizes connections and lists unhealthy ones', async () => {
    const fx = fixtures(base);
    const org = await makeOrg(fx);
    const insert = (id: string, health: string) =>
      run(
        env.DB,
        `INSERT INTO connections (id, org_id, connector_type, name, health, consecutive_failures, created_at, updated_at)
         VALUES (?, ?, 'x', ?, ?, 3, 1, 1)`,
        [id, org.id, `conn ${id}`, health],
      );
    await insert('c1', 'healthy');
    await insert('c2', 'failing');
    const s = await status();
    expect(find(s, 'connections')).toMatchObject({
      state: 'failing',
      data: { total: 2, failing: 1 },
    });
    expect(find(s, 'connection:c2')).toMatchObject({ state: 'failing', data: { orgId: org.id } });
    expect(find(s, 'connection:c1')).toBeUndefined();
  });

  it('tracks cron runs and flags overdue ones', async () => {
    const clock = new ManualClock(1_000_000_000);
    const ctx = createServiceContext(base, { clock });
    expect(find(await status({}, okFetch, clock), 'cron:daily')?.state).toBe('configured');
    await recordCronRun(ctx, 'daily');
    clearStatusCache(env.DB);
    expect(find(await status({}, okFetch, clock), 'cron:daily')?.state).toBe('verified');
    clock.advance(27 * 3_600_000);
    clearStatusCache(env.DB);
    expect(find(await status({}, okFetch, clock), 'cron:daily')?.state).toBe('degraded');
  });
});

describe('status api', () => {
  const get = (path: string, headers = fake.admin()) =>
    app.request(`/api/v1/status${path}`, { headers }, base);

  it('is admin only and /health stays minimal', async () => {
    expect((await get('', fake.user())).status).toBe(403);
    expect((await get('', {})).status).toBe(401);
    const health = await app.request('/health', {}, base);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('lists recent workflow runs newest first', async () => {
    await run(
      env.DB,
      "INSERT INTO workflow_runs (instance_id, kind, status, started_at) VALUES ('a', 'bulk_reissue', 'complete', 10), ('b', 'template_import', 'running', 20)",
    );
    const body = (await (await get('/workflows')).json()) as { items: { instanceId: string }[] };
    expect(body.items.map((i) => i.instanceId)).toEqual(['b', 'a']);
  });
});
