import { describe, expect, it } from 'vitest';
import { bump } from '../../platform/counters.ts';
import { MINUTE_CAP, minuteOf, PageBudget } from './apply-budget.ts';
import { applyKit } from './apply-test-fixtures.ts';

describe('channel apply: budget', () => {
  it('stops a page before the pass that would pass the minute budget and resumes next minute', async () => {
    const t = await applyKit();
    // The debounce moves the clock ten minutes on: that is the minute the run spends in.
    const minute = minuteOf(t.kit.clock.now() + 10 * 60_000);
    await bump(t.db, `channels:budget:apple:${minute}`, minute, MINUTE_CAP.apple - 1);
    const { workflowInstanceId: id } = (await t.saved({ apple: 'off' })) as {
      workflowInstanceId: string;
    };
    const w = t.work(id);
    expect(await w.done).toEqual({ state: 'done' });
    expect(w.s.names).toContain('rest-0');
    expect(w.s.names).toContain('page-1');
    expect(await t.retired('apple')).toHaveLength(3);
    // The first page did one pass, the next minute two more.
    expect(minuteOf(t.kit.clock.now())).toBeGreaterThan(minute);
  });

  it('caps a page by provider and tells a minute stop from a page stop', async () => {
    const budget = await PageBudget.open((await applyKit(1)).db, 0);
    expect(budget.blocked({ google: 50 })).toBeNull();
    budget.take({ google: 50 });
    expect(budget.blocked({ google: 1 })).toBe('page');
    expect(budget.blocked({ apple: 1, samsung: 1 })).toBeNull();
  });
});
