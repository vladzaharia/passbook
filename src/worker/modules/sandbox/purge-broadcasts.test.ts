import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { dailySandbox } from './jobs.ts';

const DAY = 86_400_000;
let kit: Kit;

beforeAll(async () => {
  kit = await setupKit();
});

async function broadcast(mode: 'live' | 'test', state: string, ageDays: number): Promise<string> {
  const id = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, created_at)
     VALUES (?, ?, ?, 'message', 'B', ?, '{"templateIds":["t"]}', '{"message":"Hi"}', ?)`,
    [id, kit.org.id, mode, state, kit.clock.now() - ageDays * DAY],
  );
  return id;
}

describe('daily purge of test broadcasts', () => {
  it('deletes finished test broadcasts past the window with their items; keeps the rest', async () => {
    const pass = await kit.pass({ orgId: kit.org.id, mode: 'live', memberName: 'Kept' });
    const oldSent = await broadcast('test', 'sent', 31);
    const oldDraft = await broadcast('test', 'draft', 31);
    const oldScheduled = await broadcast('test', 'scheduled', 31);
    const oldSending = await broadcast('test', 'sending', 31);
    const freshSent = await broadcast('test', 'sent', 1);
    const oldLive = await broadcast('live', 'sent', 31);
    await run(
      kit.env.DB,
      "INSERT INTO broadcast_items (broadcast_id, pass_id, outcome) VALUES (?, ?, 'updated')",
      [oldSent, pass.id],
    );

    await dailySandbox(jobCtxOf(kit));

    const ids = (await all<{ id: string }>(kit.env.DB, 'SELECT id FROM broadcasts')).map(
      (r) => r.id,
    );
    expect(ids).not.toContain(oldSent);
    expect(ids).not.toContain(oldDraft);
    expect(ids).toEqual(expect.arrayContaining([oldScheduled, oldSending, freshSent, oldLive]));
    const items = await all(
      kit.env.DB,
      'SELECT 1 AS x FROM broadcast_items WHERE broadcast_id = ?',
      [oldSent],
    );
    expect(items).toEqual([]);
    expect((await all(kit.env.DB, 'SELECT id FROM passes WHERE id = ?', [pass.id])).length).toBe(1);
  });
});

describe('purge of a large test-broadcast backlog', () => {
  it('removes one bounded slice per run and finishes the next day', async () => {
    const old = kit.clock.now() - 40 * DAY;
    const ids = Array.from({ length: 620 }, () => kit.fx.ids.id());
    for (let i = 0; i < ids.length; i += 50) {
      await Promise.all(
        ids.slice(i, i + 50).map((id) =>
          run(
            kit.env.DB,
            `INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, created_at)
             VALUES (?, ?, 'test', 'message', 'Bulk', 'sent', '{"templateIds":["t"]}', '{"message":"Hi"}', ?)`,
            [id, kit.org.id, old],
          ),
        ),
      );
    }
    const left = async () =>
      (await all<{ id: string }>(kit.env.DB, "SELECT id FROM broadcasts WHERE name = 'Bulk'"))
        .length;
    await dailySandbox(jobCtxOf(kit));
    expect(await left()).toBe(120);
    await dailySandbox(jobCtxOf(kit));
    expect(await left()).toBe(0);
  });
});
