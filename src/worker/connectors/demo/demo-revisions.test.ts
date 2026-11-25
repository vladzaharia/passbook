import { describe, expect, it } from 'vitest';
import { DATASETS } from './config.ts';
import { lastChange } from './datasets/index.ts';
import connector from './index.ts';
import { demoCtx, listRecords, str } from './test-kit.ts';

const V2 = DATASETS.filter((d) => d !== 'classic');

describe('demo revisions', () => {
  it.each(V2)('%s: changeRate 0 never changes a record', async (dataset) => {
    const a = await listRecords({ dataset, count: 40, revision: 0 });
    const b = await listRecords({ dataset, count: 40, revision: 300, changeRate: 0 });
    expect(b).toEqual(a);
  });

  it.each(V2)('%s: a change moves updatedAt and nothing about identity', async (dataset) => {
    const a = await listRecords({ dataset, count: 80 });
    const b = await listRecords({ dataset, count: 80, revision: 1, changeRate: 100 });
    for (let i = 0; i < a.length; i++) {
      expect(str(b[i] ?? {}, 'email')).toBe(str(a[i] ?? {}, 'email'));
      expect(str(b[i] ?? {}, 'updatedAt')).toBe('2026-01-05T01:00:00Z');
    }
    expect(b).not.toEqual(a);
  });

  it('changes about changeRate percent of 500 records per revision (within 5 points)', () => {
    for (const changeRate of [10, 20, 50]) {
      const c = demoCtx({ dataset: 'gym-members', count: 500, revision: 7, changeRate }).connection
        .config;
      let changed = 0;
      for (let i = 1; i <= 500; i++) {
        if (lastChange({ ...c, revision: 7 }, `m-${i}`) === 7) changed++;
      }
      expect(Math.abs((changed / 500) * 100 - changeRate)).toBeLessThanOrEqual(5);
    }
  });

  it('a record keeps its last change until the next one', async () => {
    const c = demoCtx({ dataset: 'loyalty-cards', count: 1, changeRate: 30 }).connection.config;
    let prev = 0;
    for (let r = 1; r < 60; r++) {
      const last = lastChange({ ...c, revision: r }, 'l-0001');
      expect(last).toBeGreaterThanOrEqual(prev);
      expect(last).toBeLessThanOrEqual(r);
      prev = last;
    }
  });

  it('restarts the listing when the revision changes, as v1 did', async () => {
    const ctx = demoCtx({ dataset: 'bookings', count: 120 });
    const p1 = await connector.listChanges?.(ctx, null);
    const p2 = await connector.listChanges?.(
      demoCtx({ dataset: 'bookings', count: 120, revision: 1 }),
      p1?.cursor ?? null,
    );
    expect(p2?.changes).toHaveLength(50);
  });
});
