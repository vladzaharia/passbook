// CAND-1: the sweep picks an enrolment up again when a release opens after being closed, when the plan returns,
// and it pages, orders and adopts twins without losing or duplicating work.
import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { runSystemProjection } from './projection-system.ts';
import { backfillSystemProjections } from './projection-system-backfill.ts';
import {
  drain,
  enrolled,
  type Fixture,
  job,
  queued,
  withJobs,
} from './projection-system-backfill-test-fixtures.ts';
import { queueSystemProjections } from './projection-system-queue.ts';
import { installV2Env, jobCtx, S, setup } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { listBackfillEnrolments } from './repo-projection-backfill.ts';

installV2Env();

const setRelease = (x: Fixture, state: string) =>
  run(
    x.f.kit.env.DB,
    "UPDATE wallet_provider_releases SET state = ?, changed_at = ? WHERE provider = 'google' AND mode = 'live'",
    [state, x.f.kit.clock.now()],
  );

describe('the sweep after a pair closes and opens (CAND-1)', () => {
  it('queues again once a draining pair is released again', async () => {
    const x = await enrolled();
    const sent: unknown[] = [];
    const open = setWalletProvidersEnabledForTest(true);
    try {
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
      // Draining: an Apple release queues nothing, and the sweep (released pairs only) skips the pair.
      const draining = setWalletProvidersEnabledForTest(false);
      await setRelease(x, 'draining');
      await queueSystemProjections(withJobs(x, sent), {
        id: x.f.apple.id,
        templateId: x.f.kit.template.id,
        orgId: x.f.kit.org.id,
        mode: 'live',
        provider: 'apple',
        version: x.f.kit.template.version,
      } as never);
      await drain(x, sent);
      draining();
      expect(queued(x, sent)).toHaveLength(1);
      // Released again, after the last sweep: the first drain queues what the pair missed.
      await setRelease(x, 'released');
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
    } finally {
      open();
    }
  });

  it('queues again once the wallet is back in the plan', async () => {
    const x = await enrolled();
    const sent: unknown[] = [];
    const open = setWalletProvidersEnabledForTest(true);
    const override = (value: string) =>
      run(
        x.f.kit.env.DB,
        `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
         VALUES (?, 'wallet.google', ?, ?)`,
        [x.f.kit.org.id, value, x.f.kit.clock.now()],
      );
    try {
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
      await override('0');
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(1);
      await override('1');
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
    } finally {
      open();
    }
  });
});

describe('paging, ordering and twins (CAND-1)', () => {
  it('leaves the enrolment unstamped at the page cap, then finishes on the next drain', async () => {
    const x = await enrolled();
    const sent: unknown[] = [];
    const open = setWalletProvidersEnabledForTest(true);
    try {
      x.f.kit.clock.advance(1000);
      // One source and a page of one: the page is full and the cap is reached, so it is not known to be done.
      await backfillSystemProjections(withJobs(x, sent), { page: 1, maxPages: 1 });
      expect(queued(x, sent)).toEqual([job(x)]);
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
      await drain(x, sent);
      expect(queued(x, sent)).toHaveLength(2);
    } finally {
      open();
    }
  });

  it('sweeps never-swept enrolments first, then the oldest sweep', async () => {
    const a = await enrolled();
    const b = await enrolled();
    const c = await enrolled();
    const open = setWalletProvidersEnabledForTest(true);
    try {
      const db = a.f.kit.env.DB;
      // All three are pending (the release changed after their stamps); only b was never swept.
      await run(
        db,
        "UPDATE wallet_provider_releases SET changed_at = 100 WHERE provider = 'google'",
      );
      await run(
        db,
        'UPDATE wallet_provider_accounts SET projection_backfilled_at = 50 WHERE id = ?',
        [a.accountId],
      );
      await run(
        db,
        'UPDATE wallet_provider_accounts SET projection_backfilled_at = NULL WHERE id = ?',
        [b.accountId],
      );
      await run(
        db,
        'UPDATE wallet_provider_accounts SET projection_backfilled_at = 10 WHERE id = ?',
        [c.accountId],
      );
      const order = (
        await listBackfillEnrolments(db, [{ provider: 'google', mode: 'live' }], Date.now(), 1000)
      ).map((e) => e.id);
      const at = (x: Fixture) => order.indexOf(x.accountId);
      expect([at(b) < at(c), at(c) < at(a)]).toEqual([true, true]);
      expect(at(b)).toBeGreaterThanOrEqual(0);
    } finally {
      open();
    }
  });

  it('adopts the twin of a concurrent job instead of writing a second candidate', async () => {
    const kit = await setup();
    const run2 = () =>
      runSystemProjection(jobCtx(kit.ctx), {
        kind: 'wallet.projection_system',
        orgId: kit.orgId,
        mode: 'live',
        templateId: kit.templateId,
        sourceReleaseId: kit.sourceId,
        version: kit.version,
        provider: 'google',
      });
    const results = await Promise.allSettled([run2(), run2()]);
    // The loser of the race may still collide at the approval or the release; the queue retries that. What matters
    // is that it did not write a second candidate and that the retry settles on the one release.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await run2();
    const rows = await S.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM template_candidates WHERE org_id = ? AND provider = 'google' AND author_id = 'system:wallet-projection'",
    )
      .bind(kit.orgId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect(
      (
        await S.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM template_releases WHERE org_id = ? AND provider = 'google'",
        )
          .bind(kit.orgId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});
