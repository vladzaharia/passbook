import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { ACCESS, accessTemplate } from '../scan/access-test-fixtures.ts';
import { CHECK_IN, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { dailyGuestPasses } from './guest-passes.ts';
import { ctx, DAY, gone, pass } from './guest-passes-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate(ACCESS);
});

describe('the zone a guest pass ends in', () => {
  it('uses the org zone when set and America/Los_Angeles when not, never UTC', async () => {
    const other = await makeOrg(kit.fx);
    const otherTpl = await kit.scanTemplate(
      'Zoned access',
      { actions: [CHECK_IN], access: ACCESS },
      { orgId: other.id },
    );
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'org.timeZone', '\"UTC\"', 1)",
      [`org:${other.id}`],
    );
    // The scan fixtures pin the kit org to UTC; this org must be the unset one.
    await run(kit.env.DB, "DELETE FROM settings WHERE scope = ? AND key = 'org.timeZone'", [
      `org:${kit.org.id}`,
    ]);
    clearSettingsCache(kit.env.DB);
    // No own end: the pass ends at local midnight after its start day (June 1, 12:00 UTC).
    const unzoned = await kit.scanPass(tpl, { plan: 'guest' });
    const zoned = await kit.scanPass(otherTpl, { plan: 'guest' }, { orgId: other.id });
    // The 90 day cutoff lands between the two ends: 00:00 UTC (June 2) and 00:00 Los Angeles (07:00 UTC).
    const cutoff = Date.UTC(2026, 5, 2, 3);
    kit.clock.advance(cutoff + 90 * DAY - kit.clock.now());
    await dailyGuestPasses(ctx());
    expect(await gone(zoned.id)).toBe(true);
    expect(await gone(unzoned.id)).toBe(false);
    kit.clock.advance(5 * 3_600_000);
    await dailyGuestPasses(ctx());
    expect(await gone(unzoned.id)).toBe(true);
  });
});

describe('a failing platform run', () => {
  it('is logged and does not stop the org runs', async () => {
    await run(
      kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'retention.visitorsDays', '10', 1)",
      [`org:${kit.org.id}`],
    );
    clearSettingsCache(kit.env.DB);
    const p = await pass(tpl);
    kit.clock.advance(100 * DAY);
    // The platform scan excludes orgs with their own days: it is the only query with this clause.
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            if (sql.includes('p.org_id NOT IN (SELECT value FROM json_each(?))'))
              throw new Error('platform scan failed');
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const c = createJobContext({ ...kit.env, DB: db } as never, 'visitors', { clock: kit.clock });
    const error = vi.spyOn(c.log, 'error');
    await dailyGuestPasses(c);
    expect(error.mock.calls.map(([name]) => name)).toContain('retention.guest_passes_scope_failed');
    expect(await gone(p.id)).toBe(true);
  });
});
