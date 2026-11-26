// RT-G1: class review read back, the first-tap budget, one save link for several passes, preview orgs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { PreviewOnlyError } from '../developer/fence.ts';
import {
  fixture,
  loyalty,
  mock,
  restore,
  savedObjectIds,
  tokenOf,
} from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, issueWalletOfferScoped, listWalletOffers } from './offers.ts';
import { setRuntimeAccountCheckForTest } from './offers-eligibility.ts';
import { setFirstTapBudgetForTest } from './offers-google.ts';
import { googleReleaseRejected } from './repo-google-class-write.ts';
import { combineGoogleRuntimeOffers } from './runtime-google-bundle.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const reviewRow = (db: D1Database) =>
  first<{ status: string | null; checkedAt: number | null }>(
    db,
    'SELECT review_status AS status, review_checked_at AS checkedAt FROM wallet_google_classes',
  );

describe('class review', () => {
  it('reads reviewStatus back after the class write and again until it is approved', async () => {
    const { f } = await fixture(loyalty);
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    expect((await reviewRow(f.kit.env.DB))?.status).toBe('UNDER_REVIEW');
    const [cls] = [...mock.google.loyaltyClass.values()];
    if (!cls) throw new Error('no class');
    cls.reviewStatus = 'APPROVED';
    // A pass of the same class a minute later reads the review again.
    f.kit.clock.advance(120_000);
    await run(f.kit.env.DB, 'UPDATE wallet_google_classes SET written_at = 0');
    const second = await f.kit.pass({});
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    expect((await reviewRow(f.kit.env.DB))?.status).toBe('APPROVED');
  });

  it('offers nothing while a class of the release is rejected', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    const release = await first<{ releaseId: string }>(
      f.kit.env.DB,
      'SELECT release_id AS releaseId FROM wallet_google_classes',
    );
    await run(f.kit.env.DB, "UPDATE wallet_google_classes SET review_status = 'REJECTED'");
    expect(await googleReleaseRejected(f.kit.env.DB, release?.releaseId ?? '')).toBe(true);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the first tap budget', () => {
  it('sends no class request for a class its release wrote a moment ago', async () => {
    const { f } = await fixture();
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    const second = await f.kit.pass({});
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    const sent = mock.requests.length;
    await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    const classCalls = mock.requests
      .slice(sent)
      .filter((r) => r.path.includes('genericClass') && r.method !== 'GET');
    expect(classCalls).toEqual([]);
    expect(mock.google.genericObject.size).toBe(2);
  });

  it('answers within the budget when the provider is slow', async () => {
    const { f } = await fixture();
    restore.push(setFirstTapBudgetForTest(1));
    mock.failNext({ status: 503, match: 'POST /walletobjects/v1/genericClass' });
    await expect(issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google')).rejects.toMatchObject({
      code: 'WALLET_PREPARING',
    });
  });
});

describe('one save link', () => {
  it('carries the objects of several passes', async () => {
    const { f } = await fixture();
    const second = await f.kit.pass({});
    const issued = [];
    for (const id of [f.pass.id, second.id]) {
      const [offer] = await listWalletOffers(f.kit.ctx, id);
      issued.push(
        await issueWalletOfferScoped(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google'),
      );
    }
    const [a, b] = issued;
    if (!a || !b) throw new Error('no offers');
    const link = await combineGoogleRuntimeOffers(f.kit.ctx, a.scope, [a.location, b.location]);
    expect(link.url.length).toBeLessThanOrEqual(1800);
    const ids = await savedObjectIds(link.url);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('refuses a link that is not one this server signed', async () => {
    const { f } = await fixture();
    const [offer] = await listWalletOffers(f.kit.ctx, f.pass.id);
    const one = await issueWalletOfferScoped(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    await expect(
      combineGoogleRuntimeOffers(f.kit.ctx, one.scope, [one.location, 'https://evil.test/x']),
    ).rejects.toBeDefined();
  });
});

describe('preview-only orgs', () => {
  it('are not current, and never an error', async () => {
    const { f } = await fixture();
    restore.push(
      setRuntimeAccountCheckForTest(async () => {
        throw new PreviewOnlyError();
      }),
    );
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
  });
});
