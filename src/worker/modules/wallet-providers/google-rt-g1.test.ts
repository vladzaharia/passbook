// RT-G1: class review read back, the first-tap budget, one save link for several passes, preview orgs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { PreviewOnlyError } from '../developer/fence.ts';
import { refreshGoogleClassReview } from './google-class-review.ts';
import { GoogleWalletError } from './google-errors.ts';
import { combineGoogleSaveRefs } from './google-offer.ts';
import {
  fixture,
  loyalty,
  mock,
  restore,
  savedObjectIds,
  tokenOf,
} from './google-runtime-test-fixtures.ts';
import { getWalletInstance } from './instance.ts';
import { issueWalletOffer, issueWalletOfferScoped, listWalletOffers } from './offers.ts';
import { setRuntimeAccountCheckForTest } from './offers-eligibility.ts';
import { setFirstTapBudgetForTest } from './offers-google.ts';
import { getGoogleBindingClass } from './repo-google-class.ts';
import {
  googleReleaseReviews,
  recordGoogleClass,
  setGoogleClassReview,
} from './repo-google-class-write.ts';
import { combineGoogleRuntimeOffers } from './runtime-google-bundle.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

type Fx = Awaited<ReturnType<typeof fixture>>['f'];

const classRow = (db: D1Database) =>
  first<{
    status: string | null;
    checkedAt: number | null;
    verifiedAt: number | null;
    hash: string;
    releaseId: string;
    generation: number;
    digest: string | null;
  }>(
    db,
    `SELECT review_status AS status, review_checked_at AS checkedAt, verified_at AS verifiedAt,
      class_id_hash AS hash, release_id AS releaseId, release_generation AS generation,
      body_digest AS digest FROM wallet_google_classes`,
  );

/** The review read the sync run starts under waitUntil, run to completion. */
async function review(f: Fx, passId = f.pass.id) {
  const [offer] = await listWalletOffers(f.kit.ctx, passId);
  const issued = await issueWalletOfferScoped(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
  const instance = await getWalletInstance(f.kit.env.DB, {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'google',
    passId,
  });
  const bound = await getGoogleBindingClass(f.kit.env.DB, instance?.id ?? '');
  await refreshGoogleClassReview(f.kit.ctx, issued.scope, {
    releaseId: instance?.identityProjectionReleaseId ?? '',
    type: bound?.classType ?? 'generic',
    ...(bound?.classKey ? { classKey: bound.classKey } : {}),
  });
}
const classGets = () =>
  mock.requests.filter((r) => r.method === 'GET' && /Class\//.test(r.path)).length;

describe('class review', () => {
  it('reads reviewStatus after the write, once a minute, and never again once approved', async () => {
    const { f } = await fixture(loyalty);
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    await f.kit.settle();
    expect((await classRow(f.kit.env.DB))?.status).toBe('UNDER_REVIEW');
    const [cls] = [...mock.google.loyaltyClass.values()];
    if (!cls) throw new Error('no class');
    cls.reviewStatus = 'APPROVED';
    const before = classGets();
    await review(f);
    expect(classGets()).toBe(before);
    f.kit.clock.advance(61_000);
    await review(f);
    expect(classGets()).toBe(before + 1);
    expect((await classRow(f.kit.env.DB))?.status).toBe('APPROVED');
    f.kit.clock.advance(61_000);
    await review(f);
    expect(classGets()).toBe(before + 1);
  });

  it('keeps the write and the first tap whole when the review read fails, and retries later', async () => {
    const { f } = await fixture(loyalty);
    mock.failNext({ status: 503, match: 'GET /walletobjects/v1/loyaltyClass' });
    const location = await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    await f.kit.settle();
    expect(location).toMatch(/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    expect((await classRow(f.kit.env.DB))?.status).toBeNull();
    f.kit.clock.advance(61_000);
    await review(f);
    expect((await classRow(f.kit.env.DB))?.status).toBe('UNDER_REVIEW');
  });

  it('clears the status when the body or generation moves, and fences a late read', async () => {
    const { f } = await fixture(loyalty);
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    await f.kit.settle();
    const row = await classRow(f.kit.env.DB);
    if (!row?.digest) throw new Error('no class row');
    const mine = { classIdHash: row.hash, releaseId: row.releaseId, bodyDigest: row.digest };
    await setGoogleClassReview(
      f.kit.env.DB,
      { classIdHash: row.hash, releaseGeneration: row.generation, bodyDigest: row.digest },
      'APPROVED',
    );
    // The same body again keeps what Google said.
    await recordGoogleClass(f.kit.env.DB, { ...mine, releaseGeneration: row.generation, now: 1 });
    expect((await classRow(f.kit.env.DB))?.status).toBe('APPROVED');
    // A newer generation with a new body is a new review.
    const next = await sha256Hex('another body');
    await recordGoogleClass(f.kit.env.DB, {
      ...mine,
      releaseGeneration: row.generation + 1,
      bodyDigest: next,
      now: 2,
    });
    const moved = await classRow(f.kit.env.DB);
    expect(moved).toMatchObject({ status: null, checkedAt: null });
    // A read that started before the move cannot write its answer onto the new body.
    await setGoogleClassReview(
      f.kit.env.DB,
      { classIdHash: row.hash, releaseGeneration: row.generation, bodyDigest: row.digest },
      'APPROVED',
    );
    expect((await classRow(f.kit.env.DB))?.status).toBeNull();
    // And the cleared class is read again at once, whatever it was before.
    f.kit.clock.advance(1);
    const [cls] = [...mock.google.loyaltyClass.values()];
    if (cls) cls.reviewStatus = 'REJECTED';
    await run(f.kit.env.DB, 'UPDATE wallet_google_classes SET review_checked_at = NULL');
    await review(f);
    expect((await classRow(f.kit.env.DB))?.status).toBe('REJECTED');
  });

  it('accepts the legacy underReview spelling', async () => {
    const { parseReview } = await import('./google-class-review.ts');
    expect(parseReview('underReview')).toBe('UNDER_REVIEW');
    expect(parseReview('REJECTED')).toBe('REJECTED');
    expect(parseReview('nonsense')).toBeNull();
  });

  it('offers nothing for a pass whose own class is rejected, and only that pass', async () => {
    const { f } = await fixture();
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    await f.kit.settle();
    await run(f.kit.env.DB, "UPDATE wallet_google_classes SET review_status = 'REJECTED'");
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lists the review of 150 releases without hitting the bound-variable limit', async () => {
    const { f } = await fixture();
    const ids = Array.from({ length: 150 }, (_, i) => `release-${i}`);
    expect((await googleReleaseReviews(f.kit.env.DB, ids)).size).toBe(0);
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    const row = await classRow(f.kit.env.DB);
    const map = await googleReleaseReviews(f.kit.env.DB, [...ids, ...ids, row?.releaseId ?? '']);
    expect(map.get(row?.releaseId ?? '')).toBe('waiting');
  });
});

describe('the first tap budget', () => {
  it('sends no class request for a class Google confirmed a moment ago', async () => {
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

  it('does not stamp a class confirmed by a cache hit that asked Google nothing', async () => {
    const { f } = await fixture();
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    expect((await classRow(f.kit.env.DB))?.verifiedAt).not.toBeNull();
    await run(f.kit.env.DB, 'UPDATE wallet_google_classes SET verified_at = NULL');
    const second = await f.kit.pass({});
    const [offer] = await listWalletOffers(f.kit.ctx, second.id);
    const sent = mock.requests.length;
    await issueWalletOffer(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google');
    // The isolate's memo answered the class: no class request, and still not verified.
    expect(mock.requests.slice(sent).filter((r) => r.path.includes('genericClass'))).toEqual([]);
    expect((await classRow(f.kit.env.DB))?.verifiedAt).toBeNull();
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

async function two(f: Fx) {
  const second = await f.kit.pass({});
  const issued = [];
  for (const id of [f.pass.id, second.id]) {
    const [offer] = await listWalletOffers(f.kit.ctx, id);
    issued.push(await issueWalletOfferScoped(f.kit.ctx, offer?.href.split('/')[2] ?? '', 'google'));
  }
  const [a, b] = issued;
  if (!a?.google || !b?.google) throw new Error('no offers');
  return { a, b, offers: [a.google, b.google] };
}

describe('one save link', () => {
  it('carries the objects of several passes, built from ids and nothing else', async () => {
    const { f } = await fixture();
    const { a, offers } = await two(f);
    const url = await combineGoogleRuntimeOffers(f.kit.ctx, a.scope, offers);
    expect(url.length).toBeLessThanOrEqual(1800);
    const claims = JSON.parse(
      atob(
        (url.split('/save/')[1] ?? '').split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/') ?? '',
      ),
    );
    expect(Object.keys(claims).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'origins',
      'payload',
      'typ',
    ]);
    expect(Object.keys(claims.payload)).toEqual(['genericObjects']);
    expect(claims.payload.genericObjects.every((o: object) => Object.keys(o).join() === 'id')).toBe(
      true,
    );
    const ids = await savedObjectIds(url);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(claims.exp).toBe(Math.min(...offers.map((o) => o.expiresAt)));
  });

  it('signs only known object types of its own issuer', async () => {
    const { f } = await fixture();
    const { a, offers } = await two(f);
    const [first] = offers;
    if (!first) throw new Error('no offer');
    await expect(
      combineGoogleRuntimeOffers(f.kit.ctx, a.scope, [
        { ...first, objectId: '999.other-issuer-object' as never },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      combineGoogleRuntimeOffers(f.kit.ctx, a.scope, [{ ...first, type: 'evil' as never }]),
    ).rejects.toBeInstanceOf(GoogleWalletError);
    await expect(combineGoogleRuntimeOffers(f.kit.ctx, a.scope, [])).rejects.toBeInstanceOf(
      GoogleWalletError,
    );
  });

  it('stays under Google’s limit at the longest issuer, email and type mix the validators accept', async () => {
    const key = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign'],
    );
    const issuerId = '9'.repeat(32);
    const account = {
      issuerId,
      serviceAccountEmail: `${'a'.repeat(86)}@${'p'.repeat(20)}.iam.gserviceaccount.com`.slice(
        0,
        119,
      ),
      scopes: [],
      signingKey: (key as CryptoKeyPair).privateKey,
    };
    const types = ['generic', 'event', 'loyalty', 'gift', 'offer'] as const;
    const { GOOGLE_BUNDLE_LINK_SIZE } = await import('../bundles/wallet-links.ts');
    const refs = Array.from({ length: GOOGLE_BUNDLE_LINK_SIZE }, (_, i) => ({
      objectId: `${issuerId}.${'z'.repeat(64)}`,
      type: types[i % types.length] ?? 'generic',
      expiresAt: 4_000_000_000,
    }));
    const url = await combineGoogleSaveRefs(account, refs, {
      origins: ['https://wallet.example.test'],
      issuedAt: 1_700_000_000,
    });
    expect(url.length).toBeLessThanOrEqual(1800);
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
