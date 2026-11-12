import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../platform/ids.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import {
  assertWalletRuntimeAccount,
  createSamsungRuntimeOffer,
  samsungRuntimeCardDataResponse,
  sendSamsungRuntimeUpdate,
  type VerifiedSamsungRuntimeRequest,
  verifySamsungRuntimeRequest,
  verifySamsungTombstoneRuntimeRequest,
} from './runtime.ts';
import {
  cardProjection,
  prepareRuntimeTestMaterials,
  refId,
  runtimeTestFixture,
} from './runtime-test-fixtures.ts';
import { SamsungTokenError } from './samsung.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

beforeAll(prepareRuntimeTestMaterials, 30_000);
afterEach(() => vi.unstubAllGlobals());

describe('Samsung issuance and callback fences', () => {
  it('does not infer recipient market eligibility from configured card details', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.samsungAccount();
    const responses = await f.encryptedResponseSink();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(assertWalletRuntimeAccount(f.ctx, scope, 'samsung')).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    await expect(createSamsungRuntimeOffer(f.ctx, scope, { refId })).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    await expect(
      sendSamsungRuntimeUpdate(f.ctx, scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId,
        state: 'UPDATED',
        attempt: 1,
        onProviderResponse: responses.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(responses.envelopes).toHaveLength(0);
  });

  it('never sends a deletion without a claimed revoke for that exact reference', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.samsungAccount();
    const responses = await f.encryptedResponseSink();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      sendSamsungRuntimeUpdate(f.ctx, scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId,
        state: 'DELETED',
        attempt: 1,
        onProviderResponse: responses.onProviderResponse,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(
      sendSamsungRuntimeUpdate(f.ctx, scope, {
        cc2: 'GB',
        type: 'loyalty',
        refId,
        state: 'DELETED',
        attempt: 1,
        onProviderResponse: responses.onProviderResponse,
        retirement: {
          instanceId: 'other',
          operationId: 'other-op',
          version: 1,
          claimHandle: 'a'.repeat(43),
        },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a promoted reference and never accepts a forged callback handle', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.samsungAccount();
    const request = await f.samsungRequest();
    const refHash = await sha256Hex(refId);
    let replayCalled = false;
    await expect(
      verifySamsungRuntimeRequest(f.ctx, scope, {
        request,
        refId,
        method: 'GET',
        refresh: { instanceId: 'not-promoted', refHash, operationVersion: 1 },
        claimReplay: async () => {
          replayCalled = true;
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(replayCalled).toBe(false);
    await expect(
      samsungRuntimeCardDataResponse(
        f.ctx,
        scope,
        { method: 'GET', refId } as unknown as VerifiedSamsungRuntimeRequest,
        cardProjection,
      ),
    ).rejects.toMatchObject({ code: 'provider_failure' });
  });

  it('requires the precise tombstone ref and historical scoped account', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.samsungAccount();
    const request = await f.samsungRequest();
    const tombstone = {
      orgId: scope.orgId,
      mode: scope.mode,
      accountId: scope.accountId,
      accountRevision: scope.accountRevision,
      refHash: await sha256Hex(refId),
      credentialKeysetCommitment: scope.credentialKeysetCommitment,
    };
    let replayCalled = false;
    const claimReplay = async () => {
      replayCalled = true;
      return true;
    };
    await expect(
      verifySamsungTombstoneRuntimeRequest(f.ctx, tombstone, { request, refId, claimReplay }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(
      verifySamsungTombstoneRuntimeRequest(
        f.ctx,
        {
          ...tombstone,
          credentialKeysetCommitment: '0'.repeat(64),
        },
        { request, refId, claimReplay },
      ),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(
      verifySamsungTombstoneRuntimeRequest(
        f.ctx,
        { ...tombstone, refHash: '0'.repeat(64) },
        { request, refId, claimReplay },
      ),
    ).rejects.toBeInstanceOf(SamsungTokenError);
    expect(replayCalled).toBe(false);
  });
});
