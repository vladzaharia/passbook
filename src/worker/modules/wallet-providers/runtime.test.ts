import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtures, makeOrg } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
import {
  configureWalletProviderAccount,
  readConfiguredWalletProviderCredentials,
} from './account-service.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import {
  assertWalletRuntimeAccount,
  googleRuntimeIdHashes,
  inactivateGoogleRuntimeObject,
  patchGoogleRuntimeClass,
  patchGoogleRuntimeObject,
  upsertGoogleRuntimeClass,
  upsertGoogleRuntimeObject,
} from './runtime.ts';
import { copyRuntimeScope } from './runtime-core.ts';
import {
  classProjection,
  objectProjection,
  prepareRuntimeTestMaterials,
  runtimeTestFixture,
} from './runtime-test-fixtures.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

beforeAll(prepareRuntimeTestMaterials, 30_000);
afterEach(() => vi.unstubAllGlobals());

describe('wallet issuance prerequisites', () => {
  it('copies and validates the original keyset commitment', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.scopeOf(await f.configuredGoogle());
    const copied = copyRuntimeScope(scope);
    expect(copied).toEqual(scope);
    expect(copied).not.toBe(scope);
    for (const credentialKeysetCommitment of ['', 'A'.repeat(64), 'a'.repeat(63), undefined]) {
      expect(() =>
        copyRuntimeScope({ ...scope, credentialKeysetCommitment } as typeof scope),
      ).toThrow('Wallet provider account is unavailable.');
    }
  });

  it('never signs Google offers or makes provider calls without real publication and replay proof', async () => {
    const f = await runtimeTestFixture();
    const ready = await f.configuredGoogle();
    const scope = await f.scopeOf(ready);
    const responses = await f.encryptedResponseSink();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(assertWalletRuntimeAccount(f.ctx, scope, 'google')).rejects.toMatchObject({
      code: 'account_unavailable',
    });
    await expect(f.googleOffer(scope)).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(
      googleRuntimeIdHashes(f.ctx, scope, {
        releaseId: 'release-1',
        passId: 'pass-1',
        credentialGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
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
      () => upsertGoogleRuntimeClass(f.ctx, scope, cls),
      () => patchGoogleRuntimeClass(f.ctx, scope, cls),
      () => upsertGoogleRuntimeObject(f.ctx, scope, object),
      () => patchGoogleRuntimeObject(f.ctx, scope, object),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(responses.envelopes).toHaveLength(0);
  });

  it('rejects cross-tenant, cross-mode, stale revision, and identity mismatches without disclosure', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.scopeOf(await f.configuredGoogle());
    const other = await makeOrg(fixtures(f.env, f.clock));
    for (const wrong of [
      { ...scope, orgId: other.id },
      { ...scope, mode: 'test' as const },
      { ...scope, accountId: 'other-account' },
      { ...scope, accountRevision: scope.accountRevision + 1 },
      { ...scope, providerIdentityHash: '0'.repeat(64) },
      { ...scope, providerReleaseId: 'other-release' },
    ]) {
      let failure: unknown;
      try {
        await f.googleOffer(wrong);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'account_unavailable' });
      expect(String(failure)).not.toContain(f.google.privateKeyPem);
      expect(JSON.stringify(failure)).not.toContain(f.google.serviceAccountEmail);
    }
  });

  it('preserves the encrypted Google HMAC key across credential rotation without enabling issuance', async () => {
    const f = await runtimeTestFixture();
    const first = await f.configuredGoogle();
    const scope = await f.scopeOf(first);
    const accountScope = { orgId: f.orgId, mode: 'live' as const, provider: 'google' as const };
    const before = await readConfiguredWalletProviderCredentials(f.ctx, accountScope, {
      accountId: scope.accountId,
      accountRevision: scope.accountRevision,
      credentialKeysetCommitment: scope.credentialKeysetCommitment,
    });
    if (before?.provider !== 'google') throw new Error('Missing initial credential fixture');
    const rotated = await configureWalletProviderAccount(f.ctx, f.auth, {
      ...accountScope,
      expectedRevision: scope.accountRevision,
      credentials: f.rotatedGoogle,
    });
    const nextScope = await f.scopeOf(rotated);
    const after = await readConfiguredWalletProviderCredentials(f.ctx, accountScope, {
      accountId: nextScope.accountId,
      accountRevision: nextScope.accountRevision,
      credentialKeysetCommitment: nextScope.credentialKeysetCommitment,
    });
    if (after?.provider !== 'google') throw new Error('Missing rotated credential fixture');
    expect(after.objectIdHmacKey).toEqual(before.objectIdHmacKey);
    await expect(f.googleOffer(scope)).rejects.toMatchObject({ code: 'account_unavailable' });
    await expect(f.googleOffer(nextScope)).rejects.toMatchObject({ code: 'account_unavailable' });
    const stored = await all(
      f.env.DB,
      'SELECT * FROM wallet_provider_credentials WHERE account_id = ?',
      [scope.accountId],
    );
    const audit = await all(f.env.DB, 'SELECT detail FROM audit_log WHERE target_id = ?', [
      scope.accountId,
    ]);
    for (const secret of [
      f.google.privateKeyPem,
      f.rotatedGoogle.privateKeyPem,
      f.google.serviceAccountEmail,
      f.google.issuerId,
    ]) {
      expect(JSON.stringify({ stored, audit })).not.toContain(secret);
    }
  });

  it('does not allow an unclaimed Google retirement to bypass issuance gating', async () => {
    const f = await runtimeTestFixture();
    const scope = await f.scopeOf(await f.configuredGoogle());
    const responses = await f.encryptedResponseSink();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      inactivateGoogleRuntimeObject(f.ctx, scope, {
        releaseId: 'release-1',
        passId: 'pass-1',
        credentialGeneration: 1,
        onProviderResponse: responses.onProviderResponse,
        retirement: {
          instanceId: 'other-instance',
          operationId: 'other-operation',
          version: 1,
          claimHandle: 'a'.repeat(43),
        },
      }),
    ).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
