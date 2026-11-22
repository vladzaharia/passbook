import { describe, expect, it } from 'vitest';
import { grant } from '../../platform/authority.ts';
import { setupGrant } from '../../platform/authority-test-fixtures.ts';
import { recordPassEvent } from '../events/record.ts';
import { statesOf } from './deliver-test-fixtures.ts';
import { insertEndpoint } from './repo-endpoints.ts';
import { listFeed } from './repo-feed.ts';
import { backfillDeliveries } from './repo-replay.ts';

describe('backfill', () => {
  it('skips a delivery that exists already instead of aborting the batch', async () => {
    const t = await setupGrant('wh-backfill');
    const fence = { orgId: t.s.org.id, mode: 'live' as const };
    for (const kind of ['pass.voided', 'pass.unvoided', 'pass.voided'] as const)
      await recordPassEvent(t.ctx, { orgId: fence.orgId, passId: t.s.pass.id, mode: 'live', kind });
    const seqs = (await listFeed(t.s.f.env.DB, fence, { after: 0, limit: 10 })).rows.map(
      (r) => r.seq,
    );
    expect(seqs).toHaveLength(3);
    const g = (action: string) =>
      grant(t.route, {
        purpose: `org_mode.webhooks.${action}`,
        principal: t.member(),
        tables: ['webhook_endpoints', 'webhook_deliveries'],
      });
    const create = g('endpoint.create');
    insertEndpoint(create, {
      id: 'ep-bf',
      url: 'https://hooks.example.com/a/bcde',
      description: '',
      eventTypes: ['pass.voided', 'pass.unvoided'],
      templateIds: null,
      apiVersion: '2026-11-20',
      createdBy: null,
      now: 1,
    });
    await create.commit();
    const run = async (list: number[]) => {
      const bf = g('replay');
      const st = backfillDeliveries(bf, 'ep-bf', list);
      const results = await bf.commit();
      return results[bf.indexOf(st)]?.results.length ?? 0;
    };
    expect(await run([seqs[0] as number, seqs[1] as number])).toBe(2);
    // Two of three exist: only the new one is inserted, and nothing throws.
    expect(await run(seqs)).toBe(1);
    expect(await statesOf(t.s.f.env.DB, 'ep-bf')).toEqual([{ state: 'pending', n: 3 }]);
  });
});
