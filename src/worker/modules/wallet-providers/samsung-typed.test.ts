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
import { decryptCard } from './samsung-card-test-fixtures.ts';
import { SAMSUNG_TOKEN_WINDOW_MS } from './samsung-limits.ts';
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

describe('a card that is read live, mode-aware', () => {
  // The issuance gate stays closed: its account check is stubbed so the card read decides alone.
  let restoreGate: () => void;
  beforeEach(() => {
    restoreGate = setRuntimeAccountCheckForTest(async () => {});
  });
  afterEach(() => restoreGate());

  type Offer = Awaited<ReturnType<typeof setupWalletOfferKit>>;
  async function offerable(t: Offer, template: Record<string, string>) {
    // The publish read is remembered for five minutes: look again after that.
    t.kit.clock.advance(300_001);
    const spy = t.mockTemplateFetch(t.googleCertificate, template);
    try {
      const snapshot = await offerPassSnapshot(t.kit.ctx, t.pass.id);
      if (!snapshot) throw new Error('Offer fixture pass is not offerable.');
      return (await eligibleWalletProvider(t.kit.ctx, snapshot, 'samsung')) !== null;
    } finally {
      spy.mockRestore();
    }
  }

  it('offers a launched card of the compiled type', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    expect(await offerable(t, {})).toBe(true);
  });

  it('refuses a card still in testing mode in Live, and a blocked or other-type card', async () => {
    const refused: Record<string, string>[] = [
      { testingModeOff: 'N' },
      { state: 'BLOCKED', testingModeOff: 'N' },
      { cardType: 'ticket' },
    ];
    for (const template of refused) {
      const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
      expect(await offerable(t, template)).toBe(false);
    }
  });

  it('refuses when Samsung cannot be reached', async () => {
    const t = await setupWalletOfferKit({ google: 'absent', samsungSchema: 2 });
    t.kit.clock.advance(300_001);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const snapshot = await offerPassSnapshot(t.kit.ctx, t.pass.id);
    if (!snapshot) throw new Error('Offer fixture pass is not offerable.');
    expect(await eligibleWalletProvider(t.kit.ctx, snapshot, 'samsung')).toBeNull();
  });
});
