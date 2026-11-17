import { beforeAll, describe, expect, it } from 'vitest';
import { countD1 } from '../../../../test/helpers/index.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { updatePass } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const heads = (log: string[][]) =>
  `\n${log.map((t) => `[${t.length}] ${t.map((q) => q.replace(/\s+/g, ' ').slice(0, 28)).join(' | ')}`).join('\n')}`;

describe('pass publish round trips', () => {
  it('an admin edit that changes the pass publishes in at most 10 round trips', async () => {
    const pass = await kit.pass();
    const original = kit.env.DB;
    const counted = countD1(original);
    Object.assign(kit.env, { DB: counted.db });
    try {
      await updatePass(
        jobCtxOf(kit),
        { type: 'user', id: 'admin-1' },
        pass.id,
        { input: { memberName: 'Edited' }, notify: false },
        { scope: null },
      );
    } finally {
      Object.assign(kit.env, { DB: original });
    }
    const log = counted.tripLog();
    // The publish itself: through the events batch, before the outbox dispatch and the audit row.
    const done = log.findIndex((t) => t[0]?.startsWith('INSERT INTO pass_events')) + 1;
    expect(done, heads(log)).toBeGreaterThan(0);
    expect(done, heads(log)).toBeLessThanOrEqual(10);
    // The removal snapshot, org, personalization and previous pass.json are one trip.
    expect(
      log.filter((t) => t[0]?.startsWith('SELECT removal_message')).map((t) => t.length),
    ).toEqual([4]);
  });
});
