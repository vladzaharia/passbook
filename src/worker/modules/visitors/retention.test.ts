import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { accessTemplate } from '../scan/access-test-fixtures.ts';
import { HOUR, kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { visitHeld } from './repo-retention.ts';
import { dailyVisitors } from './retention.ts';

const DAY = 24 * HOUR;
let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate();
});
const ctx = () => createJobContext(kit.env, 'visitors', { clock: kit.clock });

async function visit(endedDaysAgo: number, orgId = kit.org.id) {
  const pass = await kit.scanPass(tpl, { plan: 'guest' }, { orgId });
  const id = kit.fx.ids.id();
  const end = kit.clock.now() - endedDaysAgo * DAY;
  await run(
    kit.env.DB,
    `INSERT INTO visitors (id, org_id, mode, pass_id, name, host_name, host_email, window_from, window_until, created_at)
     VALUES (?, ?, 'live', ?, 'Leo', 'Ana', 'ana@host.test', ?, ?, 1)`,
    [id, orgId, pass.id, end - HOUR, end],
  );
  return { id, pass };
}
describe('visitors retention', () => {
  it('removes visits past the class days, with a receipt, and keeps recent ones', async () => {
    const old = await visit(500);
    const recent = await visit(2);
    await dailyVisitors(ctx());
    expect(await has(old.id)).toBe(false);
    expect(await has(recent.id)).toBe(true);
    const receipts = await all<{ class: string; deleted: number }>(
      kit.env.DB,
      "SELECT class, deleted FROM retention_receipts WHERE class = 'visitors'",
    );
    expect(receipts.length).toBeGreaterThan(0);
  });

  it('keeps a visit whose pass is held', async () => {
    const held = await visit(500);
    await run(
      kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)",
      [kit.fx.ids.id(), kit.org.id, held.pass.id],
    );
    await dailyVisitors(ctx());
    expect(await has(held.id)).toBe(true);
  });

  it('soft-deletes the visitor pass with the visit, and nothing returns the name or host', async () => {
    const old = await visit(500);
    await dailyVisitors(ctx());
    expect(await has(old.id)).toBe(false);
    const pass = await first<{ deleted_at: number | null }>(
      kit.env.DB,
      'SELECT deleted_at FROM passes WHERE id = ?',
      [old.pass.id],
    );
    expect(pass?.deleted_at).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM visitors WHERE pass_id = ?', [old.pass.id]),
    ).toBeNull();
    const receipt = await first<{ deleted: number }>(
      kit.env.DB,
      "SELECT deleted FROM retention_receipts WHERE class = 'visitors' ORDER BY ran_at DESC LIMIT 1",
    );
    expect(receipt?.deleted).toBe(2);
  });

  it('counts one removal in the receipt when the pass was already gone', async () => {
    const removed = async () =>
      (
        await first<{ n: number | null }>(
          kit.env.DB,
          "SELECT SUM(deleted) AS n FROM retention_receipts WHERE class = 'visitors'",
        )
      )?.n ?? 0;
    const old = await visit(500);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [1, old.pass.id]);
    const before = await removed();
    await dailyVisitors(ctx());
    expect(await has(old.id)).toBe(false);
    expect((await removed()) - before).toBe(1);
  });

  it('sees a hold that landed after the page was read, so the pass is not removed', async () => {
    const old = await visit(500);
    const v = { id: old.id, org_id: kit.org.id, mode: 'live' as const, pass_id: old.pass.id };
    expect(await visitHeld(kit.env.DB, v)).toBe(false);
    await run(
      kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, ?, 'platform', 'p', 'r', 1)",
      [kit.fx.ids.id(), kit.org.id, old.pass.id],
    );
    expect(await visitHeld(kit.env.DB, v)).toBe(true);
  });

  it('goes with its pass when the pass is deleted', async () => {
    const v = await visit(1);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [v.pass.id]);
    expect(await has(v.id)).toBe(false);
  });
});

async function has(id: string) {
  return (await first(kit.env.DB, 'SELECT 1 AS x FROM visitors WHERE id = ?', [id])) !== null;
}
