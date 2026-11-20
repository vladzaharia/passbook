// WA5: an org with no enrolment gets no offer, no outbound call, and the channel reason not_enrolled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makeUser } from '../../../../test/helpers/index.ts';
import { passChannels } from '../channels/service.ts';
import { getVersion } from '../templates/repo.ts';
import { holdEnrolment } from './enrolment-hold.ts';
import { listWalletOffers } from './offers.ts';
import { offerPassSnapshot, setRuntimeAccountCheckForTest } from './offers-eligibility.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { computeProjectionPins } from './projection-pins.ts';
import {
  approveProjectionCandidate,
  createProjectionCandidate,
  publishProjectionRelease,
} from './projection-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { setCompiledRuntimeForTest } from './render-projection.ts';
import { sessionFor } from './wallet-roundtrip-test-fixtures.ts';

const testEnv = installKeysetTestEnv();
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

async function channelsOf(google: 'absent' | 'configured') {
  const f = await setupWalletOfferKit({ google, samsung: 'absent', db: (await testEnv()).DB });
  restore = setWalletProvidersEnabledForTest(true);
  const { effective } = await passChannels(f.kit.ctx, f.pass);
  return { f, effective };
}

describe('per-org provider gate', () => {
  it('shows not_enrolled, lists no offer and calls nothing for an org with no enrolment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { f, effective } = await channelsOf('absent');
    expect(effective.google).toMatchObject({ on: false, source: 'org', reason: 'not_enrolled' });
    expect(effective.samsung).toMatchObject({ on: false, reason: 'not_enrolled' });
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves a configured legacy row unchanged', async () => {
    const { effective } = await channelsOf('configured');
    expect(effective.google.reason).not.toBe('not_enrolled');
  });

  it('withdraws an approved offer when the platform holds the enrolment', async () => {
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
    restore = setWalletProvidersEnabledForTest(true);
    const undo = [setCompiledRuntimeForTest(true), setRuntimeAccountCheckForTest(async () => {})];
    try {
      expect(
        await offerPassSnapshot(kit.ctx, f.pass.id, f.credentialKeysetCommitment),
      ).not.toBeNull();
      const before = await listWalletOffers(kit.ctx, f.pass.id);
      expect(before.map((o) => o.provider)).toEqual(['google']);
      kit.clock.set(Date.now());
      const admin = await sessionFor(f, (await makeUser(kit.fx)).id, ['admin', 'user'], 'live');
      await holdEnrolment(kit.ctx, admin, scope, 'abuse');
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(await listWalletOffers(kit.ctx, f.pass.id)).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      for (const u of undo) u();
    }
  });
});
