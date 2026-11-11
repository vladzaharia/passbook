import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearMetricsCache, getOverview } from './service.ts';

let base: AppEnv;

beforeAll(async () => {
  base = await makeEnv();
});
beforeEach(() => clearMetricsCache(env.DB));

describe('first-run setup counts', () => {
  it('counts orgs, assigned templates, passes and sent pass emails platform-wide', async () => {
    const clock = new ManualClock(Date.now());
    const f = fixtures(base, clock);
    const ctx = createServiceContext(base, { clock });
    const before = (await getOverview(ctx, { range: '7d' })).setup;
    const org = await makeOrg(f);
    // makePass stores its template under the org: one assigned template.
    const template = makeTemplate({ id: `tpl-setup-${org.id}`, orgId: org.id });
    await makePass(f, { orgId: org.id, template: template.resolved });
    clock.advance(1000);
    const latest = await makePass(f, { orgId: org.id, template: template.resolved });
    const outbox = (state: string) =>
      run(
        env.DB,
        "INSERT INTO outbox (id, org_id, kind, state, created_at) VALUES (?, ?, 'email', ?, ?)",
        [f.ids.id(), org.id, state, clock.now()],
      );
    await outbox('failed');
    await outbox('sent');

    clearMetricsCache(env.DB);
    const after = (await getOverview(ctx, { range: '7d' })).setup;
    expect(after).toEqual({
      orgs: before.orgs + 1,
      assignedTemplates: before.assignedTemplates + 1,
      passes: before.passes + 2,
      passEmailsSent: before.passEmailsSent + 1,
      latestPassId: latest.id,
      scanners: 0,
    });

    // The same checklist is tenant-scoped when the metrics request has an org.
    const other = await makeOrg(f);
    clearMetricsCache(env.DB);
    const scoped = await getOverview(ctx, { orgId: other.id, range: '7d' });
    expect(scoped.totals.passes).toBe(0);
    expect(scoped.setup).toEqual({
      orgs: 1,
      assignedTemplates: 0,
      passes: 0,
      passEmailsSent: 0,
      latestPassId: null,
      scanners: 0,
    });
  });

  it('skips the short cache until the first pass email, then caches again', async () => {
    const clock = new ManualClock(Date.now());
    const f = fixtures(base, clock);
    const ctx = createServiceContext(base, { clock });
    await run(env.DB, "DELETE FROM outbox WHERE kind = 'email'");
    clearMetricsCache(env.DB);
    const first = (await getOverview(ctx, { range: '24h' })).setup.orgs;
    await makeOrg(f);
    expect((await getOverview(ctx, { range: '24h' })).setup.orgs).toBe(first + 1);

    await run(
      env.DB,
      "INSERT INTO outbox (id, org_id, kind, state, created_at) VALUES (?, 'o', 'email', 'sent', ?)",
      [f.ids.id(), clock.now()],
    );
    clearMetricsCache(env.DB);
    const settled = (await getOverview(ctx, { range: '24h' })).setup.orgs;
    await makeOrg(f);
    expect((await getOverview(ctx, { range: '24h' })).setup.orgs).toBe(settled);
  });
});
