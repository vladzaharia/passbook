import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { MetricsOverviewSchema } from '../../../shared/contracts/metrics.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { eventsQuery } from './analytics-sql.ts';
import { clearMetricsCache, getOverview } from './service.ts';

const fake = fakeAuth();
const app = createApp({ stores: fake.stores });
let base: AppEnv;
let n = 0;

beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(() => clearMetricsCache(env.DB));

function setup() {
  const clock = new ManualClock(Date.now());
  return { clock, f: fixtures(base, clock), ctx: createServiceContext(base, { clock }) };
}

async function orgWithPasses(f: ReturnType<typeof fixtures>, count: number) {
  const org = await makeOrg(f);
  n += 1;
  const template = makeTemplate({ id: `tpl-metrics-${n}`, orgId: org.id });
  for (let i = 0; i < count; i++)
    await makePass(f, {
      orgId: org.id,
      template: template.resolved,
      holderEmail: `h${i}@example.test`,
    });
  return { org, template };
}

describe('metrics from D1', () => {
  it('counts per org without leaking across orgs', async () => {
    const { f, ctx } = setup();
    const a = await orgWithPasses(f, 2);
    const b = await orgWithPasses(f, 1);
    const forA = await getOverview(ctx, { orgId: a.org.id, range: '7d' });
    const forB = await getOverview(ctx, { orgId: b.org.id, range: '7d' });
    expect(forA.source).toBe('d1');
    expect(forA.unavailable).toEqual(['downloads']);
    expect(forA.totals).toMatchObject({
      passes: 2,
      activePasses: 2,
      voidedPasses: 0,
      holders: 2,
      issued: 2,
      updated: 0,
    });
    expect(forB.totals).toMatchObject({ passes: 1, issued: 1 });
    expect(forA.recent.every((r) => r.orgId === a.org.id)).toBe(true);

    const platform = await getOverview(ctx, { range: '7d' });
    expect(platform.totals.passes).toBeGreaterThanOrEqual(3);
    const byTemplate = await getOverview(ctx, {
      orgId: a.org.id,
      templateId: a.template.resolved.id,
      range: '24h',
    });
    expect(byTemplate.totals.passes).toBe(2);
    const other = await getOverview(ctx, {
      orgId: a.org.id,
      templateId: b.template.resolved.id,
      range: '24h',
    });
    expect(other.totals.passes).toBe(0);
  });

  it('zero-fills aligned buckets and places events in the right one', async () => {
    const { clock, f, ctx } = setup();
    const { org } = await orgWithPasses(f, 1);
    const o = await getOverview(ctx, { orgId: org.id, range: '7d' });
    expect(o.bucketMs).toBe(6 * 3_600_000);
    expect(o.series.issued.length).toBeGreaterThanOrEqual(28);
    expect(o.series.issued.every((p) => p.t % o.bucketMs === 0)).toBe(true);
    const hit = o.series.issued.filter((p) => p.v > 0);
    expect(hit).toHaveLength(1);
    expect(hit[0]?.t).toBe(Math.floor(clock.now() / o.bucketMs) * o.bucketMs);
    expect(o.series.downloads.every((p) => p.v === 0)).toBe(true);
    expect(o.totals.emailUnknown).toBe(0);
    expect(o.series.emailUnknown).toHaveLength(o.series.issued.length);
    expect(o.series.emailUnknown.every((p) => p.v === 0)).toBe(true);
    const parsed = MetricsOverviewSchema.parse({
      ...o,
      totals: { ...o.totals, emailUnknown: undefined },
      series: { ...o.series, emailUnknown: undefined },
    });
    expect(parsed.totals.emailUnknown).toBe(0);
    expect(parsed.series.emailUnknown).toEqual([]);
  });

  it('counts push and email outcomes, registrations and sync runs for the org only', async () => {
    const { clock, f, ctx } = setup();
    const a = await orgWithPasses(f, 1);
    const b = await orgWithPasses(f, 1);
    const at = clock.now();
    const outbox = (org: string, kind: string, state: string, errorCode: string | null = null) =>
      run(
        env.DB,
        'INSERT INTO outbox (id, org_id, kind, state, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [f.ids.id(), org, kind, state, errorCode, at],
      );
    await outbox(a.org.id, 'push', 'sent');
    await outbox(a.org.id, 'push', 'failed');
    await outbox(a.org.id, 'email', 'partial');
    await outbox(a.org.id, 'email', 'sent');
    await outbox(a.org.id, 'email', 'failed');
    await outbox(a.org.id, 'email', 'partial', 'EMAIL_OUTCOME_UNKNOWN');
    await outbox(b.org.id, 'email', 'partial', 'EMAIL_OUTCOME_UNKNOWN');
    await outbox(b.org.id, 'push', 'sent');
    const o = await getOverview(ctx, { orgId: a.org.id, range: '24h' });
    expect(o.totals).toMatchObject({
      pushes: 2,
      pushFailures: 1,
      emails: 4,
      emailFailures: 2,
      emailUnknown: 1,
    });
    expect(o.series.emails.reduce((sum, p) => sum + p.v, 0)).toBe(4);
    expect(o.series.emailFailures.reduce((sum, p) => sum + p.v, 0)).toBe(2);
    expect(o.series.emailUnknown.filter((p) => p.v > 0)).toEqual([
      { t: Math.floor(at / o.bucketMs) * o.bucketMs, v: 1 },
    ]);

    const conn = f.ids.id();
    await run(
      env.DB,
      "INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'x', 'c', 1, 1)",
      [conn, a.org.id],
    );
    await run(
      env.DB,
      "INSERT INTO connection_runs (id, connection_id, trigger, started_at) VALUES (?, ?, 'schedule', ?)",
      [f.ids.id(), conn, at],
    );
    clearMetricsCache(env.DB);
    expect((await getOverview(ctx, { orgId: a.org.id, range: '24h' })).totals.syncRuns).toBe(1);
    clearMetricsCache(env.DB);
    expect((await getOverview(ctx, { orgId: b.org.id, range: '24h' })).totals.syncRuns).toBe(0);
  });

  it('ignores events older than the range', async () => {
    const { clock, f, ctx } = setup();
    const { org } = await orgWithPasses(f, 1);
    clock.advance(2 * 86_400_000);
    expect((await getOverview(ctx, { orgId: org.id, range: '24h' })).totals.issued).toBe(0);
    clearMetricsCache(env.DB);
    expect((await getOverview(ctx, { orgId: org.id, range: '7d' })).totals.issued).toBe(1);
  });

  it('caches briefly once the platform is set up', async () => {
    const { clock, f, ctx } = setup();
    const { org } = await orgWithPasses(f, 1);
    // A pass email went out: past first run, so the short cache applies.
    await run(
      env.DB,
      "INSERT INTO outbox (id, org_id, kind, state, created_at) VALUES (?, ?, 'email', 'sent', ?)",
      [f.ids.id(), org.id, clock.now()],
    );
    const first = await getOverview(ctx, { orgId: org.id, range: '24h' });
    await orgWithPasses(f, 0);
    const template = makeTemplate({ id: `tpl-metrics-cache-${n++}`, orgId: org.id });
    await makePass(f, { orgId: org.id, template: template.resolved });
    expect((await getOverview(ctx, { orgId: org.id, range: '24h' })).totals.passes).toBe(
      first.totals.passes,
    );
    clock.advance(31_000);
    expect((await getOverview(ctx, { orgId: org.id, range: '24h' })).totals.passes).toBe(
      first.totals.passes + 1,
    );
  });
});

describe('metrics from Analytics Engine', () => {
  const binding = (rows: unknown, calls: AnalyticsSQLQuery[] = []) =>
    ({
      query: async (q: AnalyticsSQLQuery) => {
        calls.push(q);
        return rows;
      },
    }) as unknown;

  it('uses the SQL binding when present and says so', async () => {
    const { clock, f } = setup();
    const { org } = await orgWithPasses(f, 1);
    const bucketMs = 6 * 3_600_000;
    const t = Math.floor(clock.now() / bucketMs) * bucketMs;
    const calls: AnalyticsSQLQuery[] = [];
    const rows = {
      data: [
        { event: 'pass.issued', outcome: 'ok', t: t / 1000, n: '7' },
        { event: 'pass.downloaded', outcome: 'ok', t: t / 1000, n: 3 },
        { event: 'push.result', outcome: 'ok', t: t / 1000, n: 4 },
        { event: 'push.result', outcome: 'gone', t: t / 1000, n: 1 },
        { event: 'email.result', outcome: 'bounced', t: t / 1000, n: 2 },
        { event: 'email.result', outcome: 'ok', t: t / 1000, n: 3 },
        { event: 'email.result', outcome: 'unknown', t: t / 1000, n: 4 },
        { event: 'auth.sign_in', outcome: 'ok', t: t / 1000, n: 5 },
        { event: 'something.else', outcome: 'ok', t: t / 1000, n: 9 },
      ],
    };
    const e = { ...base, ANALYTICS_SQL: binding(rows, calls) } as unknown as AppEnv;
    const ctx = createServiceContext(e, { clock });
    const o = await getOverview(ctx, { orgId: org.id, range: '7d' });
    expect(o.source).toBe('analytics_engine');
    expect(o.unavailable).toEqual([]);
    expect(o.totals).toMatchObject({
      issued: 7,
      downloads: 3,
      pushes: 5,
      pushFailures: 1,
      emails: 9,
      emailFailures: 2,
      emailUnknown: 4,
      signIns: 5,
      passes: 1,
    });
    expect(o.series.emailUnknown.filter((p) => p.v > 0)).toEqual([{ t, v: 4 }]);
    expect(o.series.emailFailures.filter((p) => p.v > 0)).toEqual([{ t, v: 2 }]);
    expect(o.series.emailUnknown).toHaveLength(o.series.issued.length);
    expect(calls[0]?.query).toContain('blob2 = $orgId');
    expect(calls[0]?.params).toMatchObject({ orgId: org.id });
    expect(calls[0]?.query).toContain('FROM events.analyticsEngine.wallet_events');
    expect(calls[0]?.query).not.toContain('accountTag');
  });

  it('falls back to D1 when the binding fails or answers with junk', async () => {
    const { clock, f } = setup();
    const { org } = await orgWithPasses(f, 1);
    for (const b of [
      {
        query: async () => {
          throw new Error('boom');
        },
      },
      binding('nope'),
    ]) {
      clearMetricsCache(env.DB);
      const ctx = createServiceContext({ ...base, ANALYTICS_SQL: b } as unknown as AppEnv, {
        clock,
      });
      const o = await getOverview(ctx, { orgId: org.id, range: '24h' });
      expect(o.source).toBe('d1');
      expect(o.totals.issued).toBe(1);
    }
  });

  it('binds ids as params, never into the SQL text', () => {
    const w = { since: 0, bucketMs: 3_600_000 };
    const q = eventsQuery(w, { orgId: "x' OR 1=1 --", templateId: 'tpl_1', mode: 'live' }, 10_000);
    expect(q.query).not.toContain('OR 1=1');
    expect(q.params).toMatchObject({ orgId: "x' OR 1=1 --", templateId: 'tpl_1' });
    expect(q.query).toContain("INTERVAL '3600' SECOND");
  });
});

describe('metrics api', () => {
  const get = (q: string, headers = fake.admin()) =>
    app.request(`/api/v1/metrics/overview${q}`, { headers }, base);

  it('validates tenant input and reserves platform metrics for admins', async () => {
    expect((await get('?range=1y')).status).toBe(422);
    expect((await get('?orgId=missing')).status).toBe(404);
    expect((await get('')).status).toBe(422);
    const platform = (headers = fake.admin(), q = '') =>
      app.request(`/api/v1/metrics/platform/overview${q}`, { headers }, base);
    expect((await platform(fake.user())).status).toBe(403);
    expect((await platform(fake.apiKey())).status).toBe(401);
    expect((await platform(fake.admin(), '?orgId=missing')).status).toBe(422);
    const ok = await platform(fake.admin(), '?range=24h');
    expect(ok.status).toBe(200);
    expect(MetricsOverviewSchema.parse(await ok.json()).source).toBe('d1');
  });
});

describe('recent activity follows the mode', () => {
  it('shows audit rows in live mode and none in test mode', async () => {
    const { f, ctx } = setup();
    const a = await orgWithPasses(f, 1);
    await run(
      base.DB,
      "INSERT INTO audit_log (at, org_id, actor_type, action) VALUES (?, ?, 'user', 'pass.update')",
      [Date.now(), a.org.id],
    );
    const q = { orgId: a.org.id, range: '24h' as const };
    expect((await getOverview(ctx, q, 'live')).recent.length).toBeGreaterThan(0);
    expect((await getOverview(ctx, q, 'test')).recent).toEqual([]);
  });
});
