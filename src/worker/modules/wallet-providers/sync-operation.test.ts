import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as credentialKeyset from '../passes/credential-keyset.ts';
import { sameDb } from './db-matcher-test-fixtures.ts';
import type * as googleErrors from './google-errors.ts';
import type { WalletInstance, WalletOperation } from './instance-types.ts';
import type { WalletPassSnapshot } from './repo-instance.ts';
import type * as runtimeModule from './runtime.ts';
import type * as operationModule from './sync-operation.ts';
import type { WalletSyncRunResult } from './sync-operation-context.ts';
import type * as retirementModule from './sync-operation-retirement.ts';

const mocks = vi.hoisted(() => ({
  fresh: vi.fn(),
  claim: vi.fn(),
  getOperation: vi.fn(),
  complete: vi.fn(),
  uncertain: vi.fn(),
  record: vi.fn(),
  instance: vi.fn(),
  retire: vi.fn(),
  tombstone: vi.fn(),
  target: vi.fn(),
  inspectRef: vi.fn(),
  retireRef: vi.fn(),
  metadata: vi.fn(),
  approved: vi.fn(),
  snapshot: vi.fn(),
  passJson: vi.fn(),
  render: vi.fn(),
  callback: vi.fn(),
  googleClass: vi.fn(),
  googleObject: vi.fn(),
  googleInactive: vi.fn(),
  samsung: vi.fn(),
  ensureTargets: vi.fn(),
  listTargets: vi.fn(),
  beginTarget: vi.fn(),
  finishTarget: vi.fn(),
}));
vi.mock('./instance.ts', () => ({
  claimWalletOperation: mocks.claim,
  completeWalletOperation: mocks.complete,
  getWalletInstanceById: mocks.instance,
  getWalletOperation: mocks.getOperation,
  markWalletClaimUncertain: mocks.uncertain,
  newWalletClaimHandle: () => 'x'.repeat(43),
  recordWalletOperationOutcome: mocks.record,
  retireWalletInstance: mocks.retire,
  walletOperationFresh: mocks.fresh,
}));
vi.mock('./callbacks-ref.ts', () => ({
  getSamsungRefreshTarget: mocks.target,
  inspectSamsungRefRetirement: mocks.inspectRef,
  retireExpiredUnpromotedRef: mocks.retireRef,
}));
vi.mock('./callbacks-tombstone.ts', () => ({ persistSamsungTombstone: mocks.tombstone }));
vi.mock('./google-callback-binding.ts', () => ({ googleCallbackClassProjection: mocks.callback }));
vi.mock('./projection-service.ts', () => ({ getApprovedProjection: mocks.approved }));
vi.mock('./repo-projection.ts', () => ({ getProjectionRetirementMetadata: mocks.metadata }));
vi.mock('./repo-instance.ts', () => ({ readPassSnapshot: mocks.snapshot }));
vi.mock('../passes/repo-read-pass.ts', () => ({ currentPassJson: mocks.passJson }));
vi.mock('./render-projection.ts', () => ({ renderGoogleProjection: mocks.render }));
vi.mock('./repo-sync-targets.ts', () => ({
  ensureSamsungSyncTargets: mocks.ensureTargets,
  listSamsungSyncTargets: mocks.listTargets,
  beginSamsungSyncTarget: mocks.beginTarget,
  finishSamsungSyncTarget: mocks.finishTarget,
}));
vi.mock('./runtime.ts', () => ({
  WalletRuntimeError: class WalletRuntimeError extends Error {
    code = 'provider_failure';
    ambiguous = true;
  },
  inactivateGoogleRuntimeObject: mocks.googleInactive,
  sendSamsungRuntimeUpdate: mocks.samsung,
  upsertGoogleRuntimeClass: mocks.googleClass,
  upsertGoogleRuntimeObject: mocks.googleObject,
}));
vi.mock('./samsung.ts', () => ({
  SamsungNotificationError: class SamsungNotificationError extends Error {
    status?: number;
    kind = 'protocol';
    ambiguous = false;
    retryable = false;
    retryAfterMs?: number;
  },
}));

let GoogleWalletError: typeof googleErrors.GoogleWalletError;
let WalletRuntimeError: typeof runtimeModule.WalletRuntimeError;
let runWalletProviderOperation: typeof operationModule.runWalletProviderOperation;
let finishWalletProviderRetirement: typeof retirementModule.finishWalletProviderRetirement;

beforeAll(async () => {
  // Dynamic imports after clearing setup's module cache make the mock boundaries effective.
  vi.resetModules();
  ({ GoogleWalletError } = await import('./google-errors.ts'));
  ({ WalletRuntimeError } = await import('./runtime.ts'));
  ({ runWalletProviderOperation } = await import('./sync-operation.ts'));
  ({ finishWalletProviderRetirement } = await import('./sync-operation-retirement.ts'));
  // Provider operations only run while enabled; open the gate in the reset registry.
  (await import('./provider-policy.ts')).setWalletProvidersEnabledForTest(true);
});

let operation: WalletOperation;
let passSnapshot: WalletPassSnapshot;
const operationFields = {
  id: 'op-1',
  instanceId: 'instance-1',
  passId: 'pass-1',
  orgId: 'org-1',
  mode: 'live',
  provider: 'google',
  accountId: 'account-1',
  identityProjectionReleaseId: 'native-1',
  version: 2,
  kind: 'upsert',
  passVersion: 7,
  passRevision: 31,
  lifecycleGeneration: 1,
  credentialGeneration: 1,
  passCredentialGeneration: 1,
  issuingReleaseId: 'apple-1',
  projectionReleaseId: 'native-1',
  accountRevision: 4,
  adapterRevision: 1,
  policyRevision: 1,
  state: 'pending',
  attempts: 0,
  nextAttemptAt: null,
  claimExpiresAt: null,
  lastAttemptAt: null,
  lastResultAt: null,
  completedAt: null,
  reasonCode: null,
  httpStatus: null,
  createdAt: 1,
} as const;

function claimed(candidate: WalletOperation): WalletOperation {
  return {
    ...candidate,
    state: 'claimed',
    attempts: candidate.attempts + 1,
    lastAttemptAt: 100_000,
    claimExpiresAt: 200_000,
  };
}

const testEnv = installKeysetTestEnv();
let ctx: ServiceContext;
const projection = { provider: 'google' };

beforeEach(async () => {
  vi.resetAllMocks();
  ctx = {
    env: { ...(await testEnv()), KEK_V1: btoa('0123456789abcdef0123456789abcdef') },
    clock: { now: () => 100_000 },
  } as ServiceContext;
  const credentialKeysetCommitment = await credentialKeyset.ensureCredentialRefKeyset(
    ctx.env.DB,
    ctx.env,
  );
  operation = { ...operationFields, credentialKeysetCommitment };
  mocks.claim.mockResolvedValue('claimed');
  mocks.fresh.mockResolvedValue(true);
  mocks.getOperation.mockResolvedValue(claimed(operation));
  mocks.complete.mockResolvedValue('succeeded');
  mocks.record.mockResolvedValue('recorded');
  mocks.instance.mockResolvedValue(null);
  mocks.metadata.mockResolvedValue({
    id: 'native-1',
    generation: 1,
    orgId: 'org-1',
    mode: 'live',
    provider: 'google',
    accountId: 'account-1',
    templateId: 'template-1',
    version: 'v1',
    sourceReleaseId: 'apple-1',
    accountRevision: 4,
    adapterRevision: 1,
    policyRevision: 1,
    credentialKeysetCommitment,
    providerIdentityHash: 'a'.repeat(64),
    projection,
  });
  passSnapshot = {
    passId: operation.passId,
    orgId: operation.orgId,
    mode: operation.mode,
    templateId: 'template-1',
    templateVersion: 'v1',
    passVersion: operation.passVersion,
    passRevision: operation.passRevision,
    lifecycleGeneration: operation.lifecycleGeneration,
    credentialGeneration: operation.passCredentialGeneration,
    credentialKeysetCommitment,
    issuingReleaseId: operation.issuingReleaseId,
    status: 'active',
    removedAt: null,
    deletedAt: null,
    quarantined: 0,
    transferPending: 0,
  };
  mocks.snapshot.mockResolvedValue(passSnapshot);
  mocks.approved.mockResolvedValue({
    release: {
      id: 'native-1',
      accountId: 'account-1',
      accountRevision: 4,
      credentialKeysetCommitment,
      providerIdentityHash: 'a'.repeat(64),
    },
    projection,
  });
  mocks.passJson.mockResolvedValue('{}');
  mocks.render.mockReturnValue({ classProjection: {}, objectProjection: { state: 'ACTIVE' } });
  mocks.callback.mockResolvedValue({
    callbackOptions: { url: 'https://example.test/wallet/v1/google/account-1' },
  });
  mocks.googleClass.mockImplementation(async (_ctx, _scope, input) => {
    await input.assertCurrent();
    await input.onProviderResponse({
      stage: 'google-class',
      method: 'POST',
      status: 200,
      body: new TextEncoder().encode('class response'),
    });
    await input.assertCurrent();
  });
  mocks.googleObject.mockImplementation(async (_ctx, _scope, input) => {
    await input.assertCurrent();
    await input.onProviderResponse({
      stage: 'google-object',
      method: 'PATCH',
      status: 200,
      body: new TextEncoder().encode('object response'),
    });
    await input.assertCurrent();
  });
});

describe('wallet provider operation fences', () => {
  it('holds an in-flight operation when its keyset changes', async () => {
    const replacement = await credentialKeyset.credentialRefKeysetCommitment({
      KEK_V1: btoa('z'.repeat(32)),
    });
    mocks.googleObject.mockImplementation(async (_ctx, _scope, input) => {
      // Simulate an out-of-band keyset replacement despite the immutable production guard.
      await run(ctx.env.DB, 'DROP TRIGGER credential_ref_keyset_no_update');
      await run(ctx.env.DB, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [
        replacement,
      ]);
      await input.assertCurrent();
    });
    expect(await runWalletProviderOperation(ctx, operation)).toBe('uncertain');
    expect(mocks.googleObject).toHaveBeenCalledOnce();
    expect(mocks.uncertain).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('uses the KEK snapshot captured before the first asynchronous operation', async () => {
    const original = btoa('0123456789abcdef0123456789abcdef');
    mocks.claim.mockImplementationOnce(async () => {
      Object.assign(ctx.env, { KEK_V1: btoa('z'.repeat(32)) });
      return 'claimed';
    });
    try {
      expect(await runWalletProviderOperation(ctx, operation)).toBe('completed');
      expect(mocks.googleClass).toHaveBeenCalledWith(
        expect.objectContaining({ env: expect.objectContaining({ KEK_V1: original }) }),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      Object.assign(ctx.env, { KEK_V1: original });
    }
  });

  it('stops a stale update after a void races an in-flight provider request', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.complete.mockResolvedValue('superseded');
    mocks.googleObject.mockImplementation(async (_ctx, _scope, input) => {
      await input.assertCurrent();
      enter();
      await held;
      await input.assertCurrent();
    });
    const running = runWalletProviderOperation(ctx, operation);
    await expect(Promise.race([entered.then(() => 'entered'), running])).resolves.toBe('entered');
    mocks.fresh.mockResolvedValue(false);
    release();
    expect(await running).toBe('uncertain');
    expect(mocks.uncertain).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.googleInactive).not.toHaveBeenCalled();
  });

  it('retains an uncertain claim if transfer races an ambiguous provider write', async () => {
    mocks.googleObject.mockImplementationOnce(async (_ctx, _scope, input) => {
      mocks.fresh.mockResolvedValue(false);
      try {
        await input.assertCurrent();
      } catch {
        throw new WalletRuntimeError('provider_failure', true);
      }
    });
    expect(await runWalletProviderOperation(ctx, operation)).toBe('uncertain');
    expect(mocks.googleObject).toHaveBeenCalledOnce();
    expect(mocks.uncertain).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        instanceId: operation.instanceId,
        version: operation.version,
      }),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.googleInactive).not.toHaveBeenCalled();
  });

  it('does not publish a transferred holder into an older Google object', async () => {
    mocks.passJson.mockImplementationOnce(async () => {
      mocks.fresh.mockResolvedValue(false);
      return JSON.stringify({ name: 'New holder private data' });
    });
    expect(await runWalletProviderOperation(ctx, operation)).toBe('uncertain');
    expect(mocks.passJson).toHaveBeenCalledOnce();
    expect(mocks.callback).not.toHaveBeenCalled();
    expect(mocks.googleClass).not.toHaveBeenCalled();
    expect(mocks.googleObject).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.uncertain).toHaveBeenCalledOnce();
  });

  it('keeps a claimed old write in front of retirement and uses its original generation', async () => {
    let transferred = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke: WalletOperation = {
      ...operation,
      id: 'op-revoke',
      version: 3,
      kind: 'revoke',
      passCredentialGeneration: 2,
    };
    mocks.claim
      .mockResolvedValueOnce('claimed')
      .mockResolvedValueOnce('not_claimable')
      .mockResolvedValueOnce('not_claimable');
    mocks.getOperation.mockResolvedValueOnce(claimed(operation));
    mocks.fresh.mockImplementation(async (_db, ref) =>
      ref.version === operation.version ? !transferred : true,
    );
    mocks.complete.mockResolvedValue('superseded');
    mocks.googleObject.mockImplementation(async (_ctx, _scope, input) => {
      await input.assertCurrent();
      enter();
      await held;
      try {
        await input.assertCurrent();
      } catch {
        // A definite rejection proves this transport has settled.
        throw new GoogleWalletError('forbidden', 'runtime', 403);
      }
    });
    mocks.googleInactive.mockImplementation(async (_ctx, _scope, input) => input.assertCurrent());
    const running = runWalletProviderOperation(ctx, operation);
    await expect(Promise.race([entered.then(() => 'entered'), running])).resolves.toBe('entered');
    let settled: WalletSyncRunResult | undefined;
    try {
      transferred = true;
      expect(await runWalletProviderOperation(ctx, revoke)).toBe('not_claimed');
      expect(mocks.googleInactive).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    } finally {
      release();
      settled = await running;
    }
    expect(settled).toBe('uncertain');
    expect(await runWalletProviderOperation(ctx, revoke)).toBe('not_claimed');
    expect(mocks.uncertain).toHaveBeenCalledOnce();
    expect(mocks.googleInactive).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.passJson).toHaveBeenCalledTimes(1);
  });

  it('uses the incarnation generation for both callback and object on an upsert', async () => {
    const next: WalletOperation = {
      ...operation,
      instanceId: 'instance-2',
      credentialGeneration: 2,
      passCredentialGeneration: 2,
    };
    mocks.snapshot.mockResolvedValueOnce({ ...passSnapshot, credentialGeneration: 2 });
    mocks.getOperation.mockResolvedValueOnce(claimed(next));
    expect(await runWalletProviderOperation(ctx, next)).toBe('completed');
    expect(mocks.callback).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({
        instanceId: next.instanceId,
        credentialGeneration: 2,
      }),
    );
    expect(mocks.googleObject).toHaveBeenCalledWith(
      ctx,
      expect.anything(),
      expect.objectContaining({
        passId: next.passId,
        credentialGeneration: 2,
      }),
    );
  });

  it('does not issue a second provider request for an already claimed operation', async () => {
    mocks.claim.mockResolvedValue('already_claimed');
    expect(await runWalletProviderOperation(ctx, operation)).toBe('not_claimed');
    expect(mocks.googleClass).not.toHaveBeenCalled();
    expect(mocks.googleObject).not.toHaveBeenCalled();
  });

  it('records both ordered responses but does not infer installation from an object update', async () => {
    expect(await runWalletProviderOperation(ctx, operation)).toBe('completed');
    expect(mocks.claim).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        instanceId: operation.instanceId,
        version: operation.version,
        credentialKeysetCommitment: operation.credentialKeysetCommitment,
      }),
    );
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenNthCalledWith(1, ctx, expect.objectContaining({ sequence: 1 }));
    expect(mocks.record).toHaveBeenNthCalledWith(2, ctx, expect.objectContaining({ sequence: 2 }));
    expect(mocks.complete).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ result: { kind: 'success' } }),
    );
    expect(mocks.instance).not.toHaveBeenCalled();
  });

  it('holds Google retirement even after inactivation while replay safety is unproven', async () => {
    const revoke: WalletOperation = {
      ...operation,
      kind: 'revoke',
      state: 'succeeded',
      attempts: 1,
      lastAttemptAt: 98_000,
      lastResultAt: 99_000,
      completedAt: 99_000,
      reasonCode: 'ok',
    };
    mocks.instance.mockResolvedValue({
      id: revoke.instanceId,
      passId: revoke.passId,
      orgId: revoke.orgId,
      mode: revoke.mode,
      provider: 'google',
      accountId: revoke.accountId,
      identityProjectionReleaseId: revoke.identityProjectionReleaseId,
      credentialGeneration: revoke.credentialGeneration,
      credentialKeysetCommitment: revoke.credentialKeysetCommitment,
      lifecycle: 'revoked',
      desiredVersion: revoke.version,
      desiredOperationId: revoke.id,
      installationState: 'unknown',
      installationObservedAt: null,
      revokedAt: 99_000,
      retirementRequestedAt: 90_000,
      retiredAt: null,
      createdAt: 1,
      updatedAt: 99_000,
    } satisfies WalletInstance);
    expect(await finishWalletProviderRetirement(ctx, revoke)).toBe(false);
    expect(mocks.instance).toHaveBeenCalledOnce();
    expect(mocks.retire).not.toHaveBeenCalled();
  });

  it('fails closed rather than reassigning an existing Google class on projection change', async () => {
    mocks.render
      .mockReturnValueOnce({
        classProjection: { reviewStatus: 'UNDER_REVIEW' },
        objectProjection: {},
      })
      .mockReturnValueOnce({ classProjection: {}, objectProjection: {} });
    expect(await runWalletProviderOperation(ctx, operation)).toBe('completed');
    expect(mocks.complete).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        result: { kind: 'failure', reason: 'rejected', retryable: false },
      }),
    );
    expect(mocks.googleClass).not.toHaveBeenCalled();
    expect(mocks.googleObject).not.toHaveBeenCalled();
  });

  it('holds an ambiguous Samsung update even when its holder fence is lost', async () => {
    const samsung: WalletOperation = { ...operation, provider: 'samsung' };
    mocks.getOperation.mockResolvedValue(claimed(samsung));
    mocks.target.mockResolvedValue({ refId: 'r'.repeat(32), countryCodes: ['US'] });
    mocks.metadata.mockResolvedValue({
      id: 'native-1',
      generation: 1,
      orgId: 'org-1',
      mode: 'live',
      provider: 'samsung',
      accountId: 'account-1',
      templateId: 'template-1',
      version: 'v1',
      sourceReleaseId: 'apple-1',
      accountRevision: 4,
      adapterRevision: 1,
      policyRevision: 1,
      credentialKeysetCommitment: samsung.credentialKeysetCommitment,
      providerIdentityHash: 'a'.repeat(64),
      projection: { provider: 'samsung', cardType: 'loyalty' },
    });
    mocks.listTargets.mockResolvedValue([{ countryCode: 'US', state: 'pending', attempts: 0 }]);
    mocks.beginTarget.mockResolvedValue(1);
    mocks.finishTarget.mockResolvedValue(true);
    mocks.samsung.mockImplementation(async (_ctx, _scope, input) => {
      mocks.fresh.mockResolvedValue(false);
      await input.assertCurrent();
    });
    expect(await runWalletProviderOperation(ctx, samsung)).toBe('uncertain');
    expect(mocks.samsung).toHaveBeenCalledOnce();
    expect(mocks.finishTarget).not.toHaveBeenCalled();
    expect(mocks.uncertain).toHaveBeenCalledOnce();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('keeps Samsung installation unknown and does not consume a claim without a region', async () => {
    mocks.target.mockResolvedValue({ refId: 'r'.repeat(32), countryCodes: [] });
    const samsung: WalletOperation = { ...operation, provider: 'samsung' };
    expect(await runWalletProviderOperation(ctx, samsung)).toBe('deferred');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.samsung).not.toHaveBeenCalled();
  });

  it('records locally proven no-issuance without fabricating a provider response', async () => {
    const samsung: WalletOperation = { ...operation, provider: 'samsung', kind: 'revoke' };
    mocks.target.mockResolvedValue(null);
    mocks.inspectRef.mockResolvedValue('no_external_card');
    mocks.retireRef.mockResolvedValue('no_external_card');
    mocks.getOperation.mockResolvedValue(claimed(samsung));
    mocks.metadata.mockResolvedValue({
      id: 'native-1',
      generation: 1,
      orgId: 'org-1',
      mode: 'live',
      provider: 'samsung',
      accountId: 'account-1',
      templateId: 'template-1',
      version: 'v1',
      sourceReleaseId: 'apple-1',
      accountRevision: 4,
      adapterRevision: 1,
      policyRevision: 1,
      credentialKeysetCommitment: samsung.credentialKeysetCommitment,
      providerIdentityHash: 'a'.repeat(64),
      projection: { provider: 'samsung' },
    });
    expect(await runWalletProviderOperation(ctx, samsung)).toBe('completed');
    expect(mocks.inspectRef).toHaveBeenCalledOnce();
    expect(mocks.retireRef).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ result: { kind: 'not_issued' } }),
    );
    expect(mocks.samsung).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
