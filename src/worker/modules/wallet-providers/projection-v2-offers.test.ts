import { afterEach, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { all } from '../../platform/db.ts';
import { getVersion } from '../templates/repo.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import {
  eligibleWalletProvider,
  offerPassSnapshot,
  offerStillCurrent,
  setRuntimeAccountCheckForTest,
} from './offers-eligibility.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setPauseProbeForTest } from './projection-pause.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { addsSharingLoss, updateCompiler } from './projection-v2-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

const testEnv = installKeysetTestEnv();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});

/** A pass with a published schema 2 Google release, the gate open and the typed runtime pretended. */
async function googleFixture() {
  const f = await setupWalletOfferKit({
    google: 'configured',
    samsung: 'absent',
    db: (await testEnv()).DB,
  });
  const { kit, apple } = f;
  const version = await getVersion(kit.env.DB, kit.template.id, kit.template.version);
  if (!version) throw new Error('Offer fixture version is missing.');
  const { pins } = await computeProjectionPins(kit.ctx, 'google', version);
  const scope = { orgId: kit.org.id, mode: 'live' as const, provider: 'google' as const };
  const candidate = await createProjectionCandidate(kit.ctx, apple.authorAuth, kit.template.id, {
    ...scope,
    version: kit.template.version,
    sourceReleaseId: apple.id,
    projection: { schema: 2, provider: 'google', approvedOmissions: pins.approvedOmissions },
  });
  const approval = await approveProjectionCandidate(
    kit.ctx,
    apple.reviewerAuth,
    kit.template.id,
    candidate.id,
    { ...scope, candidateHash: candidate.candidateHash },
  );
  await publishProjectionRelease(kit.ctx, apple.publisherAuth, kit.template.id, {
    ...scope,
    candidateId: candidate.id,
    approvalId: approval.id,
    candidateHash: candidate.candidateHash,
    expectedGeneration: 0,
  });
  // Google's runtime account is unavailable by design until CW9b, and nothing renders schema 2
  // until then: pretend both so these tests are decided by the pause alone.
  restore.push(
    setWalletProvidersEnabledForTest(true),
    setRuntimeAccountCheckForTest(async () => {}),
  );
  const snapshot = await offerPassSnapshot(kit.ctx, f.pass.id);
  if (!snapshot) throw new Error('Offer fixture pass is not offerable.');
  return { f, snapshot };
}

/** The capability token of the pass, as a holder's link carries it. */
async function tokenOf(f: Awaited<ReturnType<typeof googleFixture>>['f']): Promise<string> {
  const [offer] = await listWalletOffers(f.kit.ctx, f.pass.id);
  const token = offer?.href.split('/')[2];
  if (!token) throw new Error('The unpaused release offered no link.');
  return token;
}

const noInstances = async (db: D1Database) =>
  expect(await all(db, 'SELECT 1 FROM wallet_provider_instances')).toEqual([]);

describe('Q21 on the offer paths', () => {
  it('lets an unchanged schema 2 release through, with the renderer pretended present', async () => {
    const { f, snapshot } = await googleFixture();
    const eligible = await eligibleWalletProvider(f.kit.ctx, snapshot, 'google');
    expect(eligible).not.toBeNull();
    if (!eligible) return;
    expect(await offerStillCurrent(f.kit.ctx, eligible)).toBe(true);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([
      expect.objectContaining({ provider: 'google' }),
    ]);
  });

  it('stops eligibility, a held offer, the listing and issuance when a compiler update adds an omission', async () => {
    const { f, snapshot } = await googleFixture();
    const held = await eligibleWalletProvider(f.kit.ctx, snapshot, 'google');
    expect(held).not.toBeNull();
    if (!held) return;
    const token = await tokenOf(f);

    restore.push(updateCompiler(addsSharingLoss, 1));
    expect(await eligibleWalletProvider(f.kit.ctx, snapshot, 'google')).toBeNull();
    expect(await offerStillCurrent(f.kit.ctx, held)).toBe(false);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      code: 'WALLET_OFFER_NOT_FOUND',
    });
    await noInstances(f.kit.env.DB);
  });

  it('keeps offers open when the update only changes the revision', async () => {
    const { f, snapshot } = await googleFixture();
    restore.push(updateCompiler(undefined, 1));
    expect(await eligibleWalletProvider(f.kit.ctx, snapshot, 'google')).not.toBeNull();
  });

  it('does not let a failing check reach the holder: paused, not thrown', async () => {
    const { f, snapshot } = await googleFixture();
    const token = await tokenOf(f);
    restore.push(
      setPauseProbeForTest(async () => {
        throw new Error('compiler exploded');
      }),
      updateCompiler(undefined, 1),
    );
    expect(await eligibleWalletProvider(f.kit.ctx, snapshot, 'google')).toBeNull();
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toMatchObject({
      code: 'WALLET_OFFER_NOT_FOUND',
    });
  });
});
