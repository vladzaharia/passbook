import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';
import { retentionTargets } from './targets.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});
const db = () => rk.kit.env.DB;

const set = async (orgId: string, key: string, days: number) => {
  await run(
    db(),
    'INSERT INTO settings (scope, key, value, updated_at) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value',
    [`org:${orgId}`, key, String(days)],
  );
  clearSettingsCache(db());
};

describe('retentionTargets', () => {
  it('unites the classes: an org special in either is a target, a skipped one in any is excluded', async () => {
    const a = await rk.org();
    const b = await rk.org();
    const c = await rk.org();
    await set(a.orgId, 'retention.webhooksDays', 10);
    await set(b.orgId, 'retention.eventsDays', 20);
    await set(c.orgId, 'retention.webhooksDays', 5);
    await run(
      db(),
      "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, NULL, 'platform', 'p', 'r', 1)",
      [rk.kit.fx.ids.id(), c.orgId],
    );
    const t = await retentionTargets(rk.kit.ctx, ['webhooks', 'events']);
    const byOrg = new Map(t?.orgs.map((o) => [o.orgId, o.days]));
    expect(byOrg.get(a.orgId)).toEqual({ webhooks: 10, events: t?.platform.events });
    expect(byOrg.get(b.orgId)).toEqual({ webhooks: t?.platform.webhooks, events: 20 });
    expect(byOrg.has(c.orgId)).toBe(false);
    expect(t?.exclude).toEqual(expect.arrayContaining([a.orgId, b.orgId, c.orgId]));
    await run(
      db(),
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ?",
      [c.orgId],
    );
    await run(db(), 'DELETE FROM settings WHERE scope LIKE ?', ['org:%']);
    clearSettingsCache(db());
  });

  it('26 special orgs: 25 today, the last tomorrow, then the rotation wraps', async () => {
    const orgs = [];
    for (let i = 0; i < 26; i++) {
      const o = await rk.org();
      await set(o.orgId, 'retention.importsDays', 10);
      orgs.push(o.orgId);
    }
    const first = await retentionTargets(rk.kit.ctx, ['imports']);
    expect(first?.orgs).toHaveLength(25);
    await first?.finish(25);
    const second = await retentionTargets(rk.kit.ctx, ['imports']);
    // The rotation starts at the org the first batch did not reach, then wraps.
    const missed = orgs.filter((o) => !first?.orgs.some((f) => f.orgId === o));
    expect(missed).toHaveLength(1);
    expect(second?.orgs[0]?.orgId).toBe(missed[0]);
    // A partial run moves the cursor only past the orgs that ran.
    await second?.finish(1);
    const third = await retentionTargets(rk.kit.ctx, ['imports']);
    expect(third?.orgs[0]?.orgId).toBe(second?.orgs[0] && first?.orgs[0]?.orgId);
  });
});
