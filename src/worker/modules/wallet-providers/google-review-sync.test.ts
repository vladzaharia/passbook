// RT-G1: the minute hook reads Google's class review for classes nobody touches, within its bounds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { syncGoogleClassReviews } from './google-review-sync.ts';
import { fixture, loyalty, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { listDueGoogleClassReviews } from './repo-google-review.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

type Fx = Awaited<ReturnType<typeof fixture>>['f'];
const row = (db: D1Database) =>
  first<{ status: string | null; failures: number; checkedAt: number | null }>(
    db,
    'SELECT review_status AS status, review_failures AS failures, review_checked_at AS checkedAt FROM wallet_google_classes',
  );
const gets = () => mock.requests.filter((r) => r.method === 'GET' && /Class\//.test(r.path)).length;

/** A loyalty class that Google still has under review, written by one tap. */
async function pending() {
  const { f } = await fixture(loyalty);
  await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
  await f.kit.settle();
  const [cls] = [...mock.google.loyaltyClass.values()];
  if (!cls) throw new Error('no class');
  expect((await row(f.kit.env.DB))?.status).toBe('UNDER_REVIEW');
  return { f, cls };
}
const tick = async (f: Fx) => {
  await syncGoogleClassReviews(jobCtxOf(f.kit));
  await f.kit.settle();
};

describe('the review sync tick', () => {
  it('reads an untouched pending class until Google approves it', async () => {
    const { f, cls } = await pending();
    cls.reviewStatus = 'APPROVED';
    f.kit.clock.advance(61_000);
    await tick(f);
    expect((await row(f.kit.env.DB))?.status).toBe('APPROVED');
    // Settled: never read again.
    const before = gets();
    f.kit.clock.advance(7 * 3_600_000);
    await tick(f);
    expect(gets()).toBe(before);
  });

  it('never reads a rejected class again', async () => {
    const { f } = await pending();
    await run(f.kit.env.DB, "UPDATE wallet_google_classes SET review_status = 'REJECTED'");
    const before = gets();
    f.kit.clock.advance(7 * 3_600_000);
    await tick(f);
    expect(gets()).toBe(before);
    expect((await row(f.kit.env.DB))?.status).toBe('REJECTED');
  });

  it('backs off a failing read: 1, 5 and 30 minutes, then 6 hours', async () => {
    const { f } = await pending();
    mock.failNext({ status: 503, match: 'GET /walletobjects/v1/loyaltyClass', times: 10 });
    // After 0, 1, 2, 3 and 4 failures in a row the next read waits 1, 1, 5, 30 minutes and 6 hours.
    const waits = [60_000, 60_000, 300_000, 1_800_000, 21_600_000];
    let reads = gets();
    for (const [i, wait] of waits.entries()) {
      f.kit.clock.advance(wait - 1_000);
      await tick(f);
      expect(gets()).toBe(reads); // not due yet
      f.kit.clock.advance(1_000);
      await tick(f);
      reads += 1;
      expect(gets()).toBe(reads);
      expect((await row(f.kit.env.DB))?.failures).toBe(i + 1);
    }
  });

  it('takes at most the limit, oldest check first', async () => {
    // Each extra class needs a real issued offer (about 0.3 s alone, minutes under a loaded CI), so the
    // limit is small; the tick passes REVIEW_TICK_BATCH to this same statement.
    const limit = 3;
    const { f } = await pending();
    const klass = await first<{ hash: string; releaseId: string }>(
      f.kit.env.DB,
      'SELECT class_id_hash AS hash, release_id AS releaseId FROM wallet_google_classes',
    );
    for (let i = 0; i < limit + 3; i++) {
      const second = await f.kit.pass({});
      const [offer] = await listWalletOffers(f.kit.ctx, second.id);
      await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
      const hash = i.toString(16).padStart(64, 'a');
      await run(
        f.kit.env.DB,
        `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, written_at, review_checked_at)
        VALUES (?, ?, 0, 0, ?)`,
        [hash, klass?.releaseId ?? '', 1000 + i],
      );
      await run(
        f.kit.env.DB,
        'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = (SELECT id FROM wallet_provider_instances WHERE pass_id = ?)',
        [hash, second.id],
      );
    }
    const due = await listDueGoogleClassReviews(
      f.kit.env.DB,
      f.kit.clock.now() + 10_000_000,
      limit,
    );
    expect(due).toHaveLength(limit);
    const checked = await all<{ hash: string }>(
      f.kit.env.DB,
      `SELECT class_id_hash AS hash FROM wallet_google_classes ORDER BY COALESCE(review_checked_at, 0) LIMIT ${limit}`,
    );
    expect(due.map((d) => d.classIdHash)).toEqual(checked.map((c) => c.hash));
  });

  it('reads nothing while the provider is dark', async () => {
    const { f } = await pending();
    restore.push(setWalletProvidersEnabledForTest(false));
    f.kit.clock.advance(7 * 3_600_000);
    const sent = mock.requests.length;
    await tick(f);
    expect(mock.requests.length).toBe(sent);
  });

  it('backs off a row whose class does not derive to its id, and reads the rows behind it', async () => {
    const { f, cls } = await pending();
    const real = await first<{ hash: string; releaseId: string }>(
      f.kit.env.DB,
      'SELECT class_id_hash AS hash, release_id AS releaseId FROM wallet_google_classes',
    );
    // A row selected first (oldest check) whose binding points at an id the derivation never gives.
    const fake = 'b'.repeat(64);
    const second = await f.kit.pass({});
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    await run(
      f.kit.env.DB,
      `INSERT INTO wallet_google_classes (class_id_hash, release_id, release_generation, written_at, review_checked_at)
      VALUES (?, ?, 0, 0, 1)`,
      [fake, real?.releaseId ?? ''],
    );
    await run(
      f.kit.env.DB,
      'UPDATE wallet_google_callback_bindings SET class_id_hash = ? WHERE instance_id = (SELECT id FROM wallet_provider_instances WHERE pass_id = ?)',
      [fake, second.id],
    );
    cls.reviewStatus = 'APPROVED';
    f.kit.clock.advance(61_000);
    await tick(f);
    const bad = await first<{ failures: number; checkedAt: number }>(
      f.kit.env.DB,
      'SELECT review_failures AS failures, review_checked_at AS checkedAt FROM wallet_google_classes WHERE class_id_hash = ?',
      [fake],
    );
    expect(bad?.failures).toBe(1);
    expect(bad?.checkedAt).toBe(f.kit.clock.now());
    // The real class behind it was read in the same tick, and the bad row is no longer first.
    const ok = await first<{ status: string }>(
      f.kit.env.DB,
      'SELECT review_status AS status FROM wallet_google_classes WHERE class_id_hash = ?',
      [real?.hash ?? ''],
    );
    expect(ok?.status).toBe('APPROVED');
    const due = await listDueGoogleClassReviews(f.kit.env.DB, f.kit.clock.now(), 25);
    expect(due.map((d) => d.classIdHash)).not.toContain(fake);
  });
});
