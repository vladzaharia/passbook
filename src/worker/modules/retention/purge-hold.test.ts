import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { deleteOrg } from '../orgs/service.ts';
import { dailyPasses } from '../passes/jobs.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { deletePass } from '../passes/service.ts';

const DAY = 86_400_000;
let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});
const actor = { type: 'system' as const, id: null };
const exists = async (id: string) =>
  (await first(kit.env.DB, 'SELECT 1 AS x FROM passes WHERE id = ?', [id])) !== null;
const hold = (passId: string | null, orgId = kit.org.id) =>
  run(
    kit.env.DB,
    `INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)`,
    [kit.fx.ids.id(), orgId, passId],
  );

describe('pass purge and holds', () => {
  it('a pass under a pass hold, or an org-wide hold, is not purged; a released hold lets it go', async () => {
    const held = await kit.pass();
    const free = await kit.pass();
    await deletePass(jobCtxOf(kit), actor, held.id, null);
    await deletePass(jobCtxOf(kit), actor, free.id, null);
    await hold(held.id);
    kit.clock.advance(8 * DAY);
    await dailyPasses(kit.ctx);
    expect(await exists(held.id)).toBe(true);
    expect(await exists(free.id)).toBe(false);
    await run(
      kit.env.DB,
      'UPDATE retention_holds SET released_at = 2, released_by = ? WHERE pass_id = ?',
      ['p', held.id],
    );
    await dailyPasses(kit.ctx);
    expect(await exists(held.id)).toBe(false);
  });

  it('an org-wide hold stops every purge in the org', async () => {
    const pass = await kit.pass();
    await deletePass(jobCtxOf(kit), actor, pass.id, null);
    await hold(null);
    kit.clock.advance(8 * DAY);
    await dailyPasses(kit.ctx);
    expect(await exists(pass.id)).toBe(true);
    await run(
      kit.env.DB,
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
      [kit.org.id],
    );
    await dailyPasses(kit.ctx);
    expect(await exists(pass.id)).toBe(false);
  });
});

describe('org delete and holds', () => {
  it('is refused while any hold is active and allowed after release', async () => {
    const { makeOrg } = await import('../../../../test/helpers/index.ts');
    const o = await makeOrg(kit.fx);
    await hold(null, o.id);
    const admin = { userId: 'a', sessionId: 's' } as never;
    await expect(deleteOrg(kit.ctx, actor, o.id, admin)).rejects.toMatchObject({
      status: 409,
      code: 'ORG_HELD',
    });
    await run(
      kit.env.DB,
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
      [o.id],
    );
    await expect(deleteOrg(kit.ctx, actor, o.id, admin)).rejects.not.toMatchObject({
      code: 'ORG_HELD',
    });
  });
});
