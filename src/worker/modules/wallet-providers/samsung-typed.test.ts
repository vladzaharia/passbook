import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { all, first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import { claimWalletOperation, completeWalletOperation, newWalletClaimHandle } from './instance.ts';
import {
  eligibleWalletProvider,
  offerPassSnapshot,
  setRuntimeAccountCheckForTest,
} from './offers-eligibility.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { identityCardType, providerIdentityHash } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { releaseCardType } from './repo-card-type.ts';
import { getProjectionCandidate } from './repo-projection-store.ts';
import { samsungCardStateFresh } from './repo-samsung-card-state.ts';
import { refreshExpiringSamsungEvidence } from './repo-samsung-evidence-refresh.ts';
import { decryptCard } from './samsung-card-test-fixtures.ts';
import { samsungCardId, samsungTypeHasCard } from './samsung-cards.ts';
import { SAMSUNG_TOKEN_WINDOW_MS } from './samsung-limits.ts';
import {
  refreshSamsungCardState,
  refreshSamsungProjectionEvidence,
} from './samsung-verification.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});
afterEach(() => vi.restoreAllMocks());

const cardOf = z.object({
  card: z.object({
    type: z.string(),
    subType: z.string(),
    data: z.array(
      z.object({
        refId: z.string(),
        state: z.string(),
        createdAt: z.number(),
        updatedAt: z.number(),
        attributes: z.record(z.string(), z.unknown()),
      }),
    ),
  }),
});

type Callbacks = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

async function getCard(t: Callbacks, signedQuery = '') {
  const response = await t.call({
    token: await t.token({ signedPath: `${t.path}${signedQuery}` }),
    query: signedQuery,
  });
  expect(response.status).toBe(200);
  const { cdata } = z.object({ cdata: z.string() }).parse(await response.json());
  return cardOf.parse(
    await decryptCard(cdata, t.samsung.partnerCertificatePem, t.samsung.partnerPrivateKeyPem),
  );
}

describe('Samsung Get Card Data from the compiler', () => {
  it('serves the card the compiler writes for the approved type, from the pass as it is now', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    const { card } = await getCard(t);
    expect(card.type).toBe('loyalty');
    expect(card.subType).toBe('others');
    const [item] = card.data;
    expect(item).toMatchObject({ refId: t.refId, state: 'ACTIVE' });
    expect(item?.attributes).toMatchObject({
      title: 'Alex Morgan',
      providerName: 'Test Gym',
      appLinkName: 'Test Gym',
      appLinkData: `${t.kit.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/account`,
    });
    // The art is a PassBook-hosted copy, and no undocumented extension is sent.
    expect(String(item?.attributes.appLinkLogo)).toMatch(/\/w\/i\/[0-9a-f]{64}\.png$/);
    expect(
      Object.keys(item?.attributes ?? {}).some((key) => key.startsWith('extendedFields')),
    ).toBe(false);
    // updatedAt is the pass's revision time, never the clock.
    const pass = await first<{ modified_at: number }>(
      t.kit.env.DB,
      'SELECT modified_at FROM passes WHERE id = ?',
      [t.pass.id],
    );
    expect(item?.updatedAt).toBe(Math.max(item?.createdAt ?? 0, pass?.modified_at ?? 0));
  });

  it('does no template read, art cut or write before the token verifies', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    const put = vi.spyOn(t.kit.env.BUCKET, 'put');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const before = await all(t.kit.env.DB, 'SELECT * FROM wallet_projection_art');
    const forged = `${(await t.token()).slice(0, -6)}AAAAAA`;
    expect((await t.call({ token: forged })).status).toBe(401);
    expect((await t.call()).status).toBe(401);
    expect(put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await all(t.kit.env.DB, 'SELECT * FROM wallet_projection_art')).toEqual(before);
  });

  it('narrows to the fields Samsung asks for', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    const { card } = await getCard(t, '?fields=title');
    expect(Object.keys(card.data[0]?.attributes ?? {})).toEqual(['title']);
  });

  it('answers with Samsung unreachable: nothing waits on stored evidence', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    // Past the five minutes a stored proof would have lived.
    t.kit.clock.advance(SAMSUNG_TOKEN_WINDOW_MS + 1);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const { card } = await getCard(t);
    expect(card.data[0]?.state).toBe('ACTIVE');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('evidence outside queue predicates', () => {
  it('releases and reads a compiled card with no evidence row at all', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    const db = t.kit.env.DB;
    expect(await all(db, 'SELECT 1 FROM wallet_provider_projection_evidence')).toEqual([]);
    expect(await all(db, 'SELECT 1 FROM wallet_provider_projection_evidence_history')).toEqual([]);
    const approved = await getApprovedProjection(t.kit.ctx, {
      orgId: t.kit.org.id,
      mode: 'live',
      provider: 'samsung',
      templateId: t.pass.templateId,
      templateVersion: t.pass.templateVersion,
      appleReleaseId: t.pass.releaseId ?? '',
    });
    expect(approved?.projection).toMatchObject({
      schema: 2,
      provider: 'samsung',
      type: 'loyalty',
    });
  });

  it('claims a revoke and writes its tombstone with no evidence history', async () => {
    const t = await setupSamsungCallbacks({ samsungSchema: 2 });
    const db = t.kit.env.DB;
    const revoke = await queueWalletOperation(walletJobCtx(db), {
      ...t.operation,
      kind: 'revoke',
      expectedVersion: t.operation.version,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => t.kit.ctx.ids.id(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing revoke fixture');
    const claim = {
      orgId: revoke.orgId,
      mode: revoke.mode,
      provider: 'samsung' as const,
      instanceId: revoke.instanceId,
      version: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(db), claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(t.kit), {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(
      await persistSamsungTombstone(t.kit.ctx, {
        orgId: revoke.orgId,
        mode: revoke.mode,
        instanceId: revoke.instanceId,
        operationVersion: revoke.version,
      }),
    ).toBe(true);
    expect(await all(db, 'SELECT 1 FROM wallet_samsung_tombstones')).toHaveLength(1);
  });
});

describe('Samsung card ids per type', () => {
  it('pins a compiled release to the card of its type', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    const release = t.samsungRelease;
    if (!release) throw new Error('Missing release fixture');
    const withTicket = { ...t.samsung, cardIds: { ticket: 'eventcard' } };
    const identity = (type: string) =>
      providerIdentityHash({ provider: 'samsung', credentials: withTicket }, type);
    // Loyalty has no card of its own here, so it rides the default card; a ticket does not.
    expect(await identity('loyalty')).toBe(
      await providerIdentityHash({ provider: 'samsung', credentials: t.samsung }, 'loyalty'),
    );
    expect(await identity('ticket')).not.toBe(await identity('loyalty'));
    const approved = await getApprovedProjection(t.kit.ctx, {
      orgId: t.kit.org.id,
      mode: 'live',
      provider: 'samsung',
      templateId: t.pass.templateId,
      templateVersion: t.pass.templateVersion,
      appleReleaseId: t.pass.releaseId ?? '',
    });
    expect(approved?.release.providerIdentityHash).toBe(await identity('loyalty'));
    expect(approved && identityCardType(approved.projection)).toBe('loyalty');
    expect(await releaseCardType(t.kit.env.DB, t.kit.org.id, release.id)).toBe('loyalty');
  });
});

describe('the card state is a row, read live only by the paths that decide', () => {
  type Offer = Awaited<ReturnType<typeof setupWalletOfferKit>>;
  // The issuance gate stays closed: its account check is stubbed so the card state decides alone.
  let restoreGate: () => void;
  beforeEach(() => {
    restoreGate = setRuntimeAccountCheckForTest(async () => {});
  });
  afterEach(() => restoreGate());

  async function candidateOf(t: Offer) {
    const candidate = await getProjectionCandidate(
      t.kit.env.DB,
      t.samsungRelease?.candidateId ?? '',
    );
    if (!candidate) throw new Error('Missing candidate fixture');
    return candidate;
  }
  async function offered(t: Offer): Promise<boolean> {
    const snapshot = await offerPassSnapshot(t.kit.ctx, t.pass.id);
    if (!snapshot) throw new Error('Offer fixture pass is not offerable.');
    return (await eligibleWalletProvider(t.kit.ctx, snapshot, 'samsung')) !== null;
  }

  it('records the live read at publish and offers from the row without calling Samsung', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    const row = await first<{ card_type: string; testing_mode_off: string }>(
      t.kit.env.DB,
      'SELECT card_type, testing_mode_off FROM wallet_samsung_card_state WHERE candidate_id = ?',
      [t.samsungRelease?.candidateId ?? ''],
    );
    expect(row).toEqual({ card_type: 'loyalty', testing_mode_off: 'Y' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await offered(t)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('withholds the offer once the row is older than five minutes, still without calling Samsung', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    t.kit.clock.advance(300_001);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await offered(t)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the sync job reads the card again and the row makes the offer fresh', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    t.kit.clock.advance(300_001);
    const spy = t.mockTemplateFetch(t.googleCertificate);
    try {
      expect(await refreshExpiringSamsungEvidence(jobCtxOf(t.kit), 10)).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(await offered(t)).toBe(true);
  });

  it('a refused read removes the row: testing mode in Live, a blocked card, another type, no answer', async () => {
    const refused: Record<string, string>[] = [
      { testingModeOff: 'N' },
      { state: 'BLOCKED', testingModeOff: 'N' },
      { cardType: 'ticket' },
    ];
    for (const template of refused) {
      const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
      const spy = t.mockTemplateFetch(t.googleCertificate, template);
      const candidate = await candidateOf(t);
      try {
        expect(await refreshSamsungCardState(t.kit.ctx, candidate)).toBeNull();
      } finally {
        spy.mockRestore();
      }
      expect(
        await all(t.kit.env.DB, 'SELECT 1 FROM wallet_samsung_card_state WHERE candidate_id = ?', [
          candidate.id,
        ]),
      ).toEqual([]);
      expect(await offered(t)).toBe(false);
    }
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    expect(await refreshSamsungCardState(t.kit.ctx, await candidateOf(t))).toBeNull();
    expect(await offered(t)).toBe(false);
  });

  it('the admin recheck is a real read with real times, and replaces the row', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    t.kit.clock.advance(120_000);
    const spy = t.mockTemplateFetch(t.googleCertificate);
    try {
      const result = await refreshSamsungProjectionEvidence(t.kit.ctx, t.auth, {
        orgId: t.kit.org.id,
        mode: 'live',
        candidateId: t.samsungRelease?.candidateId ?? '',
        candidateHash: t.samsungRelease?.candidateHash ?? '',
      });
      expect(result).toEqual({
        verified: true,
        verifiedAt: t.kit.clock.now(),
        expiresAt: t.kit.clock.now() + 300_000,
      });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps one row per candidate: another organization or mode is never read through it', async () => {
    const a = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    const b = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    const candidate = await candidateOf(a);
    // A candidate of another organization, or the same one in another mode, finds no fresh row.
    expect(
      await samsungCardStateFresh(
        b.kit.env.DB,
        { ...candidate, id: 'other' },
        'loyalty',
        a.kit.clock.now(),
      ),
    ).toBe(false);
    expect(
      await samsungCardStateFresh(
        a.kit.env.DB,
        { ...candidate, accountEpoch: candidate.accountEpoch + 1 },
        'loyalty',
        a.kit.clock.now(),
      ),
    ).toBe(false);
    expect(await samsungCardStateFresh(a.kit.env.DB, candidate, 'ticket', a.kit.clock.now())).toBe(
      false,
    );
    expect(
      await samsungCardStateFresh(
        a.kit.env.DB,
        { ...candidate, candidateHash: 'x' },
        'loyalty',
        a.kit.clock.now(),
      ),
    ).toBe(false);
    expect(await samsungCardStateFresh(a.kit.env.DB, candidate, 'loyalty', a.kit.clock.now())).toBe(
      true,
    );
  });
});

describe('a type with no card of its own', () => {
  it('loyalty rides the default card; ticket, coupon and others need their own', () => {
    const credentials = { cardId: 'default', cardIds: { ticket: 'own' } };
    expect(samsungTypeHasCard(credentials, 'loyalty')).toBe(true);
    expect(samsungTypeHasCard(credentials, 'ticket')).toBe(true);
    expect(samsungTypeHasCard(credentials, 'coupon')).toBe(false);
    expect(samsungTypeHasCard({ cardId: 'default' }, 'ticket')).toBe(false);
    expect(samsungTypeHasCard(credentials, 'constructor')).toBe(false);
  });

  it('never resolves a prototype key to a card', () => {
    const credentials = { cardId: 'default', cardIds: { loyalty: 'own' } };
    expect(samsungCardId(credentials, 'loyalty')).toBe('own');
    expect(samsungCardId(credentials, 'constructor')).toBe('default');
    expect(samsungCardId(credentials, 'ticket')).toBe('default');
  });
});
