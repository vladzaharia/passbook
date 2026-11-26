import { expect } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  retireWalletInstance,
} from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { releaseRows } from './release-test-fixtures.ts';
import { insertInstance } from './repo-instance.ts';
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

/** A live Samsung copy on a pass, with helpers to turn its channel off, settle and replace it. */
export async function setupSamsungChannelOff() {
  const f = await setupSamsungCallbacks();
  const db = f.kit.env.DB;
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, f.kit.env);
  // Successors (channel_epoch > 1) need the provider released in the database too (0229).
  await releaseRows(db);
  const scope = {
    orgId: f.pass.orgId,
    mode: f.pass.mode,
    provider: 'samsung' as const,
    credentialKeysetCommitment,
  };
  const instanceId = f.operation.instanceId;
  const instance = async (id = instanceId) => {
    const row = await getWalletInstanceById(db, { ...scope, instanceId: id });
    if (!row) throw new Error('Missing instance');
    return row;
  };
  const marker = (retiredAt: number | null) =>
    run(
      db,
      `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, retired_at, retired_cause,
        set_by, set_at) VALUES (?, ?, ?, ?, 'samsung', ?, ?, 'test', ?)
      ON CONFLICT (pass_id, channel) DO UPDATE SET retired_at = excluded.retired_at,
        retired_cause = excluded.retired_cause`,
      [
        f.pass.id,
        f.pass.orgId,
        f.pass.mode,
        f.pass.templateId,
        retiredAt,
        retiredAt === null ? null : 'pass',
        f.kit.clock.now(),
      ],
    );
  /** Claim and complete the instance's desired revoke the way the sync worker does. */
  async function settleRevoke(id = instanceId) {
    const current = await instance(id);
    const claim = {
      ...scope,
      instanceId: id,
      version: current.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: f.kit.clock.now(),
    };
    expect(await claimWalletOperation(walletJobCtx(db), claim)).toBe('claimed');
    expect(
      await completeWalletOperation(jobCtxOf(f.kit), { ...claim, result: { kind: 'success' } }),
    ).toBe('succeeded');
    return claim;
  }
  /** Off, revoke settled, tombstones written, copy retired. */
  async function turnOffAndRetire() {
    await marker(f.kit.clock.now());
    await reconcileWalletInstance(jobCtxOf(f.kit), await instance());
    const claim = await settleRevoke();
    await persistSamsungTombstone(f.kit.ctx, {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId: claim.instanceId,
      operationVersion: claim.version,
    });
    expect(await retireWalletInstance(db, { ...claim, now: f.kit.clock.now() })).toBe(true);
    return claim;
  }
  async function successorInput() {
    const predecessor = await instance();
    const snapshot = await readWalletPassSnapshot(db, { ...scope, passId: f.pass.id });
    if (!snapshot) throw new Error('Missing pass snapshot');
    return {
      ...scope,
      passId: f.pass.id,
      passVersion: snapshot.passVersion,
      passRevision: snapshot.passRevision,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      passCredentialGeneration: snapshot.credentialGeneration,
      issuingReleaseId: snapshot.issuingReleaseId,
      projectionReleaseId: f.operation.projectionReleaseId,
      accountId: f.operation.accountId,
      accountRevision: f.operation.accountRevision,
      adapterRevision: f.operation.adapterRevision,
      policyRevision: f.operation.policyRevision,
      instanceId: f.kit.ctx.ids.id(),
      operationId: f.kit.ctx.ids.id(),
      requestHash: await sha256Hex(f.kit.ctx.ids.token(32)),
      now: f.kit.clock.now(),
      channelEpoch: predecessor.channelEpoch + 1,
    };
  }
  const instanceCount = async () =>
    (await all(db, 'SELECT 1 FROM wallet_provider_instances WHERE pass_id = ?', [f.pass.id]))
      .length;
  return {
    ...f,
    db,
    scope,
    instance,
    marker,
    settleRevoke,
    turnOffAndRetire,
    successorInput,
    insertInstance: (input: Awaited<ReturnType<typeof successorInput>>) =>
      insertInstance(db, input),
    instanceCount,
  };
}
