import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as credentialKeyset from '../passes/credential-keyset.ts';
import type * as accountService from './account-service.ts';
import { sameDb } from './db-matcher-test-fixtures.ts';
import type { WalletInstance } from './instance-types.ts';
import type * as lifecycleModule from './lifecycle.ts';

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  queue: vi.fn(),
  requestRetirement: vi.fn(),
  retirePlaceholder: vi.fn(),
  pass: vi.fn(),
  instance: vi.fn(),
  instanceByPass: vi.fn(),
  approved: vi.fn(),
  original: vi.fn(),
  countries: vi.fn(),
}));
vi.mock('./account-service.ts', async () => {
  const actual = await vi.importActual<typeof accountService>('./account-service.ts');
  return { ...actual, getWalletProviderReadiness: mocks.account };
});
vi.mock('./instance.ts', () => ({
  queueWalletOperation: mocks.queue,
  requestWalletRetirement: mocks.requestRetirement,
  retireUnissuedWalletPlaceholder: mocks.retirePlaceholder,
}));
vi.mock('./projection-service.ts', () => ({ getApprovedProjection: mocks.approved }));
vi.mock('./repo-projection.ts', () => ({ getProjectionRetirementMetadata: mocks.original }));
vi.mock('./repo-instance.ts', () => ({
  readPassSnapshot: mocks.pass,
  getInstanceById: mocks.instance,
  getInstanceByPass: mocks.instanceByPass,
}));
vi.mock('./repo-sync-targets.ts', () => ({ samsungSyncCountryHints: mocks.countries }));

let onWalletPassUpdated: typeof lifecycleModule.onWalletPassUpdated;
let reconcileWalletInstance: typeof lifecycleModule.reconcileWalletInstance;

beforeAll(async () => {
  // A dynamic import after clearing setup's module cache makes the mock boundaries effective.
  vi.resetModules();
  ({ onWalletPassUpdated, reconcileWalletInstance } = await import('./lifecycle.ts'));
});

const testEnv = installKeysetTestEnv();
let ctx: ServiceContext;
let instance: WalletInstance;
const instanceFields = {
  id: 'instance-1',
  passId: 'pass-1',
  orgId: 'org-1',
  mode: 'live',
  provider: 'samsung',
  accountId: 'account-1',
  identityProjectionReleaseId: 'native-1',
  credentialGeneration: 1,
  lifecycle: 'active',
  desiredVersion: 1,
  desiredOperationId: 'old-op',
  installationState: 'unknown',
  installationObservedAt: null,
  revokedAt: null,
  retirementRequestedAt: 99_000,
  retiredAt: null,
  createdAt: 1,
  updatedAt: 99_000,
} as const;
const pass = {
  passId: 'pass-1',
  orgId: 'org-1',
  mode: 'live',
  templateId: 'template-1',
  templateVersion: 'v1',
  passVersion: 3,
  passRevision: 14,
  lifecycleGeneration: 0,
  credentialGeneration: 2,
  issuingReleaseId: 'apple-1',
  status: 'active',
  removedAt: null,
  deletedAt: null,
  quarantined: 0,
  transferPending: 0,
};

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
  instance = { ...instanceFields, credentialKeysetCommitment };
  mocks.account.mockResolvedValue({ accountId: 'account-1', state: 'configured', revision: 4 });
  mocks.pass.mockResolvedValue({ ...pass, credentialKeysetCommitment });
  mocks.original.mockResolvedValue({
    id: 'native-1',
    generation: 1,
    accountId: 'account-1',
    orgId: 'org-1',
    mode: 'live',
    provider: 'samsung',
    templateId: 'template-1',
    version: 'v1',
    sourceReleaseId: 'apple-1',
    accountRevision: 4,
    credentialKeysetCommitment,
    adapterRevision: 1,
    policyRevision: 1,
    providerIdentityHash: 'a'.repeat(64),
  });
  mocks.countries.mockResolvedValue([]);
  mocks.queue.mockResolvedValue({ id: 'revoke-op', version: 2, state: 'pending' });
  mocks.instance.mockResolvedValue({
    ...instance,
    desiredOperationId: 'revoke-op',
    desiredVersion: 2,
  });
});

describe('native wallet holder transitions', () => {
  it('never adopts a replacement keyset for a retained instance', async () => {
    const replacement = await credentialKeyset.credentialRefKeysetCommitment({
      KEK_V1: btoa('z'.repeat(32)),
    });
    expect(
      await reconcileWalletInstance(ctx, { ...instance, credentialKeysetCommitment: replacement }),
    ).toBe('blocked');
    expect(mocks.pass).not.toHaveBeenCalled();
    expect(mocks.requestRetirement).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('rejects a pass hook whose captured keyset no longer matches', async () => {
    const replacement = await credentialKeyset.credentialRefKeysetCommitment({
      KEK_V1: btoa('z'.repeat(32)),
    });
    instance = { ...instance, credentialKeysetCommitment: replacement };
    expect(
      await onWalletPassUpdated(ctx, {
        orgId: pass.orgId,
        mode: 'live',
        passId: pass.passId,
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        lifecycleGeneration: pass.lifecycleGeneration,
        passCredentialGeneration: pass.credentialGeneration,
        credentialKeysetCommitment: instance.credentialKeysetCommitment,
      }),
    ).toEqual({ scheduled: 0, blocked: 0, stale: true });
    expect(mocks.pass).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('reconciles an active reassigned pass as retirement, never as an update for the new holder', async () => {
    expect(await reconcileWalletInstance(ctx, instance)).toBe('scheduled');
    expect(mocks.queue).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        kind: 'revoke',
        passId: pass.passId,
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        projectionReleaseId: instance.identityProjectionReleaseId,
      }),
    );
    expect(mocks.approved).not.toHaveBeenCalled();
  });

  it('stages permanent retirement for an older generation before scheduling its revoke', async () => {
    mocks.requestRetirement.mockResolvedValue(true);
    expect(await reconcileWalletInstance(ctx, { ...instance, retirementRequestedAt: null })).toBe(
      'scheduled',
    );
    expect(mocks.requestRetirement).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        instanceId: instance.id,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    );
    expect(mocks.queue).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        kind: 'revoke',
        passCredentialGeneration: pass.credentialGeneration,
      }),
    );
    expect(mocks.approved).not.toHaveBeenCalled();
  });

  it('retires the current old-holder identity while a transfer is pending', async () => {
    mocks.pass.mockResolvedValue({
      ...pass,
      transferPending: 1,
      credentialKeysetCommitment: instance.credentialKeysetCommitment,
    });
    mocks.requestRetirement.mockResolvedValue(true);
    expect(await reconcileWalletInstance(ctx, { ...instance, retirementRequestedAt: null })).toBe(
      'scheduled',
    );
    expect(mocks.requestRetirement).toHaveBeenCalledOnce();
    expect(mocks.queue).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        kind: 'revoke',
        passCredentialGeneration: pass.credentialGeneration,
      }),
    );
    expect(mocks.approved).not.toHaveBeenCalled();
  });

  it('never schedules a target-generation instance while its transfer is blocked', async () => {
    mocks.pass.mockResolvedValue({
      ...pass,
      transferPending: 1,
      credentialKeysetCommitment: instance.credentialKeysetCommitment,
    });
    const target: WalletInstance = {
      ...instance,
      credentialGeneration: pass.credentialGeneration,
      lifecycle: 'blocked',
      accountId: null,
      identityProjectionReleaseId: null,
      desiredOperationId: null,
      desiredVersion: 0,
      retirementRequestedAt: null,
    };
    expect(await reconcileWalletInstance(ctx, target)).toBe('blocked');
    expect(mocks.requestRetirement).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.approved).not.toHaveBeenCalled();
  });

  it('retires an older unissued placeholder only through the atomic no-artifact proof', async () => {
    mocks.pass.mockResolvedValue({
      ...pass,
      transferPending: 1,
      credentialKeysetCommitment: instance.credentialKeysetCommitment,
    });
    mocks.retirePlaceholder.mockResolvedValue(true);
    const old: WalletInstance = {
      ...instance,
      lifecycle: 'ready',
      accountId: null,
      identityProjectionReleaseId: null,
      desiredOperationId: null,
      desiredVersion: 0,
      retirementRequestedAt: null,
    };
    expect(await reconcileWalletInstance(ctx, old)).toBe('unchanged');
    expect(mocks.retirePlaceholder).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({
        instanceId: old.id,
        credentialGeneration: old.credentialGeneration,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    );
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it('rejects an obsolete hook snapshot instead of scheduling a later holder revision', async () => {
    expect(
      await reconcileWalletInstance(ctx, instance, {
        orgId: pass.orgId,
        mode: 'live',
        passId: pass.passId,
        passVersion: 2,
        passRevision: pass.passRevision,
        passCredentialGeneration: pass.credentialGeneration,
        credentialKeysetCommitment: instance.credentialKeysetCommitment,
        lifecycleGeneration: pass.lifecycleGeneration,
      }),
    ).toBe('stale');
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
