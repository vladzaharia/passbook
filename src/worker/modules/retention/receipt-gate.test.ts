import { beforeAll, describe, expect, it } from 'vitest';
import { prepareReceipt } from './receipt-service.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});

describe('receipt gate', () => {
  const input = { orgId: null, cls: 'webhooks', kind: 'sweep' as const, deleted: 1 };
  it('accepts a count over eligible rows with bound values', async () => {
    await expect(
      prepareReceipt(rk.kit.ctx, input, {
        sql: '(SELECT count(*) FROM event_feed WHERE event_feed.at < ?) = ?',
        params: [1, 0],
      }),
    ).resolves.toBeDefined();
  });

  it('refuses free SQL', async () => {
    for (const sql of [
      '1 = 1',
      '(SELECT count(*) FROM event_feed WHERE 1); DELETE FROM scans',
      '(SELECT count(*) FROM event_feed WHERE 1) = 1 OR EXISTS (SELECT 1 FROM x WHERE 1) -- ',
    ])
      await expect(prepareReceipt(rk.kit.ctx, input, { sql, params: [] })).rejects.toThrow();
  });
});
