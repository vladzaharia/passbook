// WA5: an org with no enrolment gets no offer, no outbound call, and the channel reason not_enrolled.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { passChannels } from '../channels/service.ts';
import { listWalletOffers } from './offers.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';

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
});
