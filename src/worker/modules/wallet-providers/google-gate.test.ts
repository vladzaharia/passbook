import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleGoogleCallback } from './google-callback-handler.ts';
import { walletProviderDisabledReason } from './provider-policy.ts';
import {
  createGoogleRuntimeOffer,
  googleRuntimeIdHashes,
  inactivateGoogleRuntimeObject,
  patchGoogleRuntimeClass,
  patchGoogleRuntimeObject,
  upsertGoogleRuntimeClass,
  upsertGoogleRuntimeObject,
} from './runtime.ts';
import {
  classProjection,
  objectProjection,
  prepareRuntimeTestMaterials,
  runtimeTestFixture,
} from './runtime-test-fixtures.ts';

beforeAll(prepareRuntimeTestMaterials, 30_000);
afterEach(() => vi.unstubAllGlobals());

// The Google blockers (token cache, key cache, timeouts, PATCH-first) must not open issuance.
describe('Google stays dark behind the policy gate', () => {
  it('rejects every runtime operation before any token exchange or REST call', async () => {
    expect(walletProviderDisabledReason('google')).toBe('not_released');
    const f = await runtimeTestFixture();
    const scope = await f.scopeOf(await f.configuredGoogle());
    const responses = await f.encryptedResponseSink();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const cls = {
      releaseId: 'release-1',
      projection: classProjection,
      onProviderResponse: responses.onProviderResponse,
    };
    const object = {
      releaseId: 'release-1',
      passId: 'pass-1',
      credentialGeneration: 1,
      projection: objectProjection,
      onProviderResponse: responses.onProviderResponse,
    };
    for (const operation of [
      () =>
        createGoogleRuntimeOffer(f.ctx, scope, {
          releaseId: 'release-1',
          passId: 'pass-1',
          credentialGeneration: 1,
          origins: ['https://passbook.mobile'],
        }),
      () =>
        googleRuntimeIdHashes(f.ctx, scope, {
          releaseId: 'release-1',
          passId: 'pass-1',
          credentialGeneration: 1,
        }),
      () => upsertGoogleRuntimeClass(f.ctx, scope, cls),
      () => patchGoogleRuntimeClass(f.ctx, scope, cls),
      () => upsertGoogleRuntimeObject(f.ctx, scope, object),
      () => patchGoogleRuntimeObject(f.ctx, scope, object),
      () =>
        inactivateGoogleRuntimeObject(f.ctx, scope, {
          releaseId: 'release-1',
          passId: 'pass-1',
          credentialGeneration: 1,
          retirement: {
            instanceId: 'instance-1',
            operationId: 'operation-1',
            version: 1,
            claimHandle: 'A'.repeat(43),
          },
          onProviderResponse: responses.onProviderResponse,
        }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'WALLET_PROVIDER_DISABLED' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(responses.envelopes).toHaveLength(0);
  }, 30_000);

  it('acknowledges callbacks without reading or decrypting any credential or fetching keys', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.scopeOf(await f.configuredGoogle());
    const statements: string[] = [];
    const db = new Proxy(f.ctx.env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string') statements.push(args[0]);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const logs: string[] = [];
    const ctx = {
      ...f.ctx,
      env: { ...f.ctx.env, DB: db },
      log: { ...f.ctx.log, info: (event: string) => void logs.push(event) },
    } as typeof f.ctx;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const request = new Request(`https://passbook.mobile/wallet/v1/google/${scope.accountId}`, {
      method: 'POST',
      body: '{"protocolVersion":"ECv2SigningOnly"}',
    });
    await expect(handleGoogleCallback(ctx, request, scope.accountId)).resolves.toBeUndefined();
    expect(logs).toContain('wallet.callback_ignored');
    expect(fetcher).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  }, 30_000);
});
