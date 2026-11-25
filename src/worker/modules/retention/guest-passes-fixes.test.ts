import { beforeAll, describe, expect, it } from 'vitest';
import { CRON_HOOKS, DAILY_CRON, handleScheduled } from '../../jobs/cron.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { deletePass } from '../passes/service.ts';
import { ACCESS, accessTemplate } from '../scan/access-test-fixtures.ts';
import { kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { stageVersion } from '../scan/action-template-read-race-test-fixtures.ts';
import { approveScanReleases } from '../scan/test-kit.ts';
import { readSystemValue } from '../settings/repo.ts';
import { dailyGuestPasses } from './guest-passes.ts';
import { ctx, DAY, gone, hold, pass, raced, receipts, row } from './guest-passes-test-fixtures.ts';
import { writeReceipt } from './receipt-service.ts';
import { GUEST_CANDIDATES_SQL } from './repo-guest-passes.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate(ACCESS);
});

describe('what the door reads', () => {
  it('keeps a pass pinned to a guest version when the active release makes the plan a member plan', async () => {
    const t = await accessTemplate(ACCESS, 'Moved plans');
    const p = await pass(t);
    await stageVersion(kit, t, 'v2', (m) => {
      const plan = m.scan?.access?.plans.find((x) => x.id === 'guest');
      if (plan) plan.kind = 'always';
    });
    await approveScanReleases(kit, t, { version: 'v2' });
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(p.id)).toBe(false);
  });

  it('keeps a test-mode pass', async () => {
    const live = await pass(tpl);
    const test = await pass(tpl, 'guest', { mode: 'test' });
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    expect(await gone(live.id)).toBe(true);
    expect(await gone(test.id)).toBe(false);
  });

  it('finds candidates through the template versions and passes_template, not a scan of passes', async () => {
    const plan = await all<{ detail: string }>(
      kit.env.DB,
      `EXPLAIN QUERY PLAN ${GUEST_CANDIDATES_SQL('org')}`,
      [0, '', kit.org.id, 10],
    );
    const text = plan.map((r) => r.detail).join('\n');
    expect(text).toMatch(/passes USING (COVERING )?INDEX passes_template/);
    expect(text).not.toMatch(/SCAN p\b|SCAN passes/);
  });
});

describe('a change after the read', () => {
  it('keeps a pass that changed (row_version) after the candidate was read', async () => {
    const p = await pass(tpl);
    kit.clock.advance(100 * DAY);
    const c = raced('read', async () => {
      await run(kit.env.DB, 'UPDATE passes SET row_version = row_version + 1 WHERE id = ?', [p.id]);
    });
    await dailyGuestPasses(c);
    expect(await row(p.id)).toMatchObject({ d: null, status: 'active' });
  });

  it('keeps a pass, unvoided, when a hold lands after the read', async () => {
    const p = await pass(tpl);
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(
      raced('read', async () => {
        await hold(kit.org.id, p.id);
      }),
    );
    expect(await row(p.id)).toMatchObject({ d: null, status: 'active' });
  });

  it('keeps a pass, unvoided, when a credential transfer starts after the read', async () => {
    const p = await pass(tpl);
    kit.clock.advance(100 * DAY);
    const c = raced('read', () =>
      run(
        kit.env.DB,
        `INSERT INTO pass_credential_transfers (id, pass_id, org_id, mode, state, source_generation, source_version,
           source_revision, source_row_version, source_lifecycle_generation, source_link_generation,
           target_holder_email, requested_by_type, requested_at)
         SELECT ?, id, org_id, mode, 'pending', credential_generation, 1, 0, row_version, lifecycle_generation,
           link_generation + 1, 'next@example.test', 'system', 1 FROM passes WHERE id = ?`,
        [kit.fx.ids.id(), p.id],
      ).then(() => undefined),
    );
    await dailyGuestPasses(c);
    expect(await row(p.id)).toMatchObject({ d: null, status: 'active' });
  });

  it('keeps the delete and still records the receipt when another receipt takes the chain slot first', async () => {
    const p = await pass(tpl);
    kit.clock.advance(100 * DAY);
    const before = (await receipts(null)).length;
    const c = raced('batch', async () => {
      await writeReceipt(ctx(), { orgId: null, cls: 'visitors', kind: 'visitor', deleted: 0 });
    });
    await dailyGuestPasses(c);
    expect(await gone(p.id)).toBe(true);
    const after = await receipts(null);
    expect(after.length).toBe(before + 2);
    expect(after.at(-1)).toMatchObject({ deleted: 1 });
  });
});

describe('deletePass', () => {
  it('refuses an in-batch write together with an authority', async () => {
    const p = await pass(tpl);
    await expect(
      deletePass(ctx(), { type: 'system', id: null }, p.id, kit.org.id, {} as never, {
        inBatch: async () => [],
      }),
    ).rejects.toThrow(/inBatch/);
    expect(await gone(p.id)).toBe(false);
  });
});

describe('the daily budget', () => {
  it('stops at its cap, keeps its place, and finishes the backlog on the next run', async () => {
    const made = [];
    for (let i = 0; i < 25; i++) made.push(await pass(tpl));
    kit.clock.advance(100 * DAY);
    await dailyGuestPasses(ctx());
    const first = (await Promise.all(made.map((p) => gone(p.id)))).filter(Boolean).length;
    expect(first).toBe(20);
    expect(await readSystemValue(kit.env.DB, 'retention.guestPassesCursors')).not.toEqual({});
    await dailyGuestPasses(ctx());
    expect(await Promise.all(made.map((p) => gone(p.id)))).not.toContain(false);
    expect(await readSystemValue(kit.env.DB, 'retention.guestPassesCursors')).toEqual({});
  });

  it('leaves room for the daily hooks after it: 50 due passes, one cron run', async () => {
    const made = [];
    for (let i = 0; i < 50; i++) made.push(await pass(tpl));
    // The cron runs on the real clock: make every pass long overdue and the grace long over.
    await run(
      kit.env.DB,
      `UPDATE passes SET created_at = 1000,
         personalization = json_set(personalization, '$.validUntil', '2020-01-01T00:00:00.000Z')
       WHERE id IN (${made.map(() => '?').join(',')})`,
      made.map((p) => p.id),
    );
    let marker = 0;
    const hooks = CRON_HOOKS[DAILY_CRON] ?? [];
    hooks.push({ name: 'test.marker', run: async () => void marker++ });
    try {
      await handleScheduled(
        { cron: DAILY_CRON, scheduledTime: Date.now() } as ScheduledController,
        kit.env as AppEnv,
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
      );
    } finally {
      hooks.pop();
    }
    const deleted = (await Promise.all(made.map((p) => gone(p.id)))).filter(Boolean).length;
    expect(marker).toBe(1);
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(50);
    expect(
      (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM passes WHERE deleted_at IS NOT NULL',
        )
      )?.n,
    ).toBeGreaterThan(0);
  }, 120_000);
});
