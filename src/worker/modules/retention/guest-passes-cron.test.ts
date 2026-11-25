import { beforeAll, expect, it } from 'vitest';
import { CRON_HOOKS, DAILY_CRON, handleScheduled } from '../../jobs/cron.ts';
import { first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { accessTemplate } from '../scan/access-test-fixtures.ts';
import { kit, setupActionFixture } from '../scan/act-test-fixtures.ts';
import { gone, pass } from './guest-passes-test-fixtures.ts';

let tpl: string;
beforeAll(async () => {
  await setupActionFixture();
  tpl = await accessTemplate();
});

// The cron runs on the real clock, so these passes (made at the fixed test time, ending then) are long overdue.
it('leaves room for the daily hooks after it: 50 due passes, one cron run', async () => {
  const made = [];
  for (let i = 0; i < 50; i++) made.push(await pass(tpl));
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
        'SELECT count(*) AS n FROM audit_log WHERE action = ?',
        ['pass.delete'],
      )
    )?.n,
  ).toBe(deleted);
}, 120_000);
