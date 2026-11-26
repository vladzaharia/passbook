// D2 end to end on the send path: a same-identity rotation moves the account revision, not its epoch, so the
// operation recorded before it still reconciles, reads its credentials and is current; an identity change does not.
import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { readSamsungPromotedRefreshCredentials } from './account-credential-read.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { getWalletInstanceById } from './instance.ts';
import { configureOn } from './legacy-on-test-fixtures.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { isCurrentApprovedProjection } from './projection-current.ts';
import { getProjectionRetirementMetadata } from './repo-projection.ts';

type Kit = Awaited<ReturnType<typeof setupSamsungCallbacks>>;

async function rotate(t: Kit) {
  const scope = { orgId: t.kit.org.id, mode: 'live' as const, provider: 'samsung' as const };
  const account = await getWalletProviderReadiness(t.kit.ctx, scope);
  await configureOn(t.kit.ctx, t.auth, {
    ...scope,
    expectedRevision: account.revision,
    credentials: t.samsung,
  });
}

/** An identity change moves the epoch (the trigger bumps it on a different identity hash). */
const changeIdentity = (t: Kit) =>
  run(
    t.kit.env.DB,
    'UPDATE wallet_provider_accounts SET authority_epoch = authority_epoch + 1 WHERE id = ?',
    [t.operation.accountId],
  );

const epochOf = async (t: Kit) =>
  (
    await first<{ e: number; r: number }>(
      t.kit.env.DB,
      'SELECT authority_epoch AS e, revision AS r FROM wallet_provider_accounts WHERE id = ?',
      [t.operation.accountId],
    )
  )?.e ?? 0;

async function proofs(t: Kit, epoch: number) {
  const op = t.operation;
  const refresh = {
    orgId: op.orgId,
    mode: op.mode,
    accountId: op.accountId,
    accountRevision: op.accountRevision,
    authorityEpoch: epoch,
    projectionReleaseId: op.projectionReleaseId,
    instanceId: op.instanceId,
    refHash: await sha256Hex(t.refId),
    operationVersion: op.version,
  };
  const metadata = await getProjectionRetirementMetadata(t.kit.env.DB, op.projectionReleaseId);
  if (!metadata) throw new Error('Missing release metadata');
  const binding = {
    orgId: op.orgId,
    mode: op.mode,
    provider: op.provider,
    accountId: op.accountId,
    accountRevision: op.accountRevision,
    accountEpoch: epoch,
    providerIdentityHash: metadata.providerIdentityHash,
    releaseId: op.projectionReleaseId,
  };
  return { refresh, binding };
}

describe('a rotation and the send path', () => {
  it('keeps reads, the current-release check and reconcile across a same-identity rotation', async () => {
    const t = await setupSamsungCallbacks({ promoted: true });
    const epoch = await epochOf(t);
    const before = await proofs(t, epoch);
    expect(await readSamsungPromotedRefreshCredentials(t.kit.ctx, before.refresh)).not.toBeNull();
    await rotate(t);
    expect(await epochOf(t), 'a same-identity rotation keeps the epoch').toBe(epoch);
    const after = await proofs(t, epoch);
    expect(await readSamsungPromotedRefreshCredentials(t.kit.ctx, after.refresh)).not.toBeNull();
    expect(await isCurrentApprovedProjection(t.kit.ctx, after.binding)).toBe(true);
    await run(t.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [t.pass.id]);
    const instance = await getWalletInstanceById(t.kit.env.DB, t.operation);
    if (!instance) throw new Error('Missing instance');
    expect(await reconcileWalletInstance(jobCtxOf(t.kit), instance)).toBe('scheduled');
  });

  it('refuses the old pin once the identity changes ', async () => {
    const t = await setupSamsungCallbacks({ promoted: true });
    const epoch = await epochOf(t);
    await changeIdentity(t);
    expect(await epochOf(t), 'an identity change moves the epoch').toBeGreaterThan(epoch);
    const old = await proofs(t, epoch);
    expect(await readSamsungPromotedRefreshCredentials(t.kit.ctx, old.refresh)).toBeNull();
    expect(await isCurrentApprovedProjection(t.kit.ctx, old.binding)).toBe(false);
  });
});
