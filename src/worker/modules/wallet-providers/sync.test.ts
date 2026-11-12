import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import * as credentialKeyset from '../passes/credential-keyset.ts';
import { sameDb } from './db-matcher-test-fixtures.ts';
import type { WalletInstance } from './instance-types.ts';
import type { DirtyWalletInstance } from './repo-instance.ts';
import type * as syncModule from './sync.ts';

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  expire: vi.fn(),
  dirty: vi.fn(),
  instance: vi.fn(),
  reconcile: vi.fn(),
  ack: vi.fn(),
  ackPlaceholder: vi.fn(),
  defer: vi.fn(),
  due: vi.fn(),
  retirements: vi.fn(),
  deferRetirement: vi.fn(),
  deferOperation: vi.fn(),
  finishRetirement: vi.fn(),
  run: vi.fn(),
}));
vi.mock('./instance.ts', () => ({
  purgeExpiredWalletOffers: mocks.purge,
  expireWalletClaims: mocks.expire,
  listDirtyWalletInstances: mocks.dirty,
  getWalletInstanceById: mocks.instance,
  ackDirtyWalletInstance: mocks.ack,
  deferDirtyWalletInstance: mocks.defer,
  listDueWalletOperations: mocks.due,
  listWalletRetirementsReady: mocks.retirements,
  deferWalletRetirement: mocks.deferRetirement,
}));
vi.mock('./lifecycle.ts', () => ({ reconcileWalletInstance: mocks.reconcile }));
vi.mock('./repo-sync-queue.ts', () => ({
  ackCleanWalletPlaceholder: mocks.ackPlaceholder,
  deferWalletSyncOperation: mocks.deferOperation,
}));
vi.mock('./sync-operation-retirement.ts', () => ({
  finishWalletProviderRetirement: mocks.finishRetirement,
}));
vi.mock('./sync-operation.ts', () => ({
  runWalletProviderOperation: mocks.run,
}));

let drainWalletProviderSync: typeof syncModule.drainWalletProviderSync;

beforeAll(async () => {
  // A dynamic import after clearing setup's module cache makes the queue mocks effective.
  vi.resetModules();
  ({ drainWalletProviderSync } = await import('./sync.ts'));
  // The queue below only runs while providers are enabled; open the gate in the reset registry.
  (await import('./provider-policy.ts')).setWalletProvidersEnabledForTest(true);
});

let item: DirtyWalletInstance;
let placeholder: WalletInstance;
const testEnv = installKeysetTestEnv();
let ctx: ServiceContext;

beforeEach(async () => {
  vi.resetAllMocks();
  ctx = {
    env: { ...(await testEnv()), KEK_V1: btoa('0123456789abcdef0123456789abcdef') },
    clock: { now: () => 123_000 },
    log: { warn: vi.fn() },
  } as unknown as ServiceContext;
  const credentialKeysetCommitment = await credentialKeyset.ensureCredentialRefKeyset(
    ctx.env.DB,
    ctx.env,
  );
  item = {
    instanceId: 'instance-1',
    passId: 'pass-1',
    orgId: 'org-1',
    mode: 'live',
    provider: 'samsung',
    generation: 4,
    credentialKeysetCommitment,
  };
  placeholder = {
    id: item.instanceId,
    passId: item.passId,
    orgId: item.orgId,
    mode: item.mode,
    provider: item.provider,
    credentialGeneration: 1,
    credentialKeysetCommitment,
    lifecycle: 'blocked',
    accountId: null,
    identityProjectionReleaseId: null,
    desiredVersion: 0,
    desiredOperationId: null,
    installationState: 'unknown',
    installationObservedAt: null,
    revokedAt: null,
    retirementRequestedAt: null,
    retiredAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  mocks.dirty.mockResolvedValue([item]);
  mocks.instance.mockResolvedValue(placeholder);
  mocks.reconcile.mockResolvedValue('blocked');
  mocks.ackPlaceholder.mockResolvedValue(true);
  mocks.due.mockResolvedValue([]);
  mocks.retirements.mockResolvedValue([]);
});

describe('wallet sync dirty placeholders', () => {
  it('does not acknowledge or schedule anything when the keyset is unavailable', async () => {
    Object.assign(ctx.env, { KEK_V1: btoa('z'.repeat(32)) });
    await expect(drainWalletProviderSync(ctx)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    expect(mocks.expire).not.toHaveBeenCalled();
    expect(mocks.dirty).not.toHaveBeenCalled();
    expect(mocks.ackPlaceholder).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('acknowledges only via the pristine generation-fenced placeholder proof', async () => {
    await drainWalletProviderSync(ctx);
    expect(mocks.dirty).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      123_000,
      30,
      item.credentialKeysetCommitment,
    );
    expect(mocks.instance).toHaveBeenCalledWith(sameDb(ctx.env.DB), item);
    expect(mocks.reconcile).toHaveBeenCalledWith(
      expect.anything(),
      placeholder,
      undefined,
      false,
      item.credentialKeysetCommitment,
    );
    expect(mocks.ackPlaceholder).toHaveBeenCalledWith(sameDb(ctx.env.DB), item);
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(mocks.defer).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('defers rather than clearing when the placeholder proof or dirty generation changed', async () => {
    mocks.ackPlaceholder.mockResolvedValue(false);
    await drainWalletProviderSync(ctx);
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(mocks.defer).toHaveBeenCalledWith(
      sameDb(ctx.env.DB),
      expect.objectContaining({ ...item, now: 123_000 }),
    );
  });

  it('never applies the placeholder shortcut to a bound provider instance', async () => {
    mocks.instance.mockResolvedValue({
      ...placeholder,
      lifecycle: 'active',
      accountId: 'account-1',
      identityProjectionReleaseId: 'native-1',
      desiredVersion: 1,
      desiredOperationId: 'op-1',
    } satisfies WalletInstance);
    await drainWalletProviderSync(ctx);
    expect(mocks.ackPlaceholder).not.toHaveBeenCalled();
    expect(mocks.defer).toHaveBeenCalledOnce();
  });
});
