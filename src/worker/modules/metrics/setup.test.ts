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
  it('counts orgs, assigned templates, passes and sent pass emails per scope', async () => {
    const clock = new ManualClock(Date.now());
    const f = fixtures(base, clock);
    const ctx = createServiceContext(base, { clock });
    const org = await makeOrg(f);
    const empty = await getOverview(ctx, { orgId: org.id, range: '7d' });
    expect(empty.setup).toEqual({
      orgs: 1,
      assignedTemplates: 0,
      passes: 0,
      passEmailsSent: 0,
      latestPassId: null,
    });

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
    const done = await getOverview(ctx, { orgId: org.id, range: '7d' });
    expect(done.setup).toEqual({
      orgs: 1,
      assignedTemplates: 1,
      passes: 2,
      passEmailsSent: 1,
      latestPassId: latest.id,
    });

    const other = await makeOrg(f);
    clearMetricsCache(env.DB);
    const scoped = await getOverview(ctx, { orgId: other.id, range: '7d' });
    expect(scoped.setup).toMatchObject({ passes: 0, passEmailsSent: 0, latestPassId: null });
    const platform = await getOverview(ctx, { range: '7d' });
    expect(platform.setup.orgs).toBeGreaterThanOrEqual(2);
    expect(platform.setup.passEmailsSent).toBeGreaterThanOrEqual(1);
  });
});
