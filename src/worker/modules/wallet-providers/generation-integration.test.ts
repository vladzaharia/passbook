import { beforeAll, describe, expect, it } from 'vitest';
import { all, batch, first, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { passForToken } from '../public/service.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  consumeWalletOfferRef,
  createWalletInstance,
  createWalletOfferRef,
  getWalletInstance,
  getWalletInstanceById,
  getWalletOperation,
  markWalletClaimUncertain,
  newWalletClaimHandle,
  readWalletPassSnapshot,
  retireWalletInstance,
} from './instance.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { projectionPolicy } from './projection-contract.ts';
import { getApprovedProjection } from './projection-service.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { seedHistoricalOfferRef } from './runtime-historical-fixtures.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

/**
 * Exercise the storage transition for a hypothetical already-proven future provider incarnation.
 * Only this isolated fixture bypasses the two issuance guards, and restores them in the same D1
 * transaction. It does not supply market evidence, create an offer, or enable production issuance.
 */
async function seedReadyActivation(input: {
  db: D1Database;
  instanceId: string;
  accountId: string;
  releaseId: string;
  now: number;
}) {
  const { db, instanceId, accountId, releaseId, now } = input;
  const names = [
    'wallet_provider_generation_operation_guard',
    'wallet_provider_generation_binding_guard',
  ];
  const triggers = await all<{ name: string; sql: string }>(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?)",
    names,
  );
  const operationGuard = triggers.find((row) => row.name === names[0])?.sql;
  const bindingGuard = triggers.find((row) => row.name === names[1])?.sql;
  if (!operationGuard || !bindingGuard) throw new Error('Missing provider issuance guards');
  const operationId = crypto.randomUUID();
  const requestHash = await sha256Hex(crypto.randomUUID());
  const results = await batch(db, [
    stmt(db, 'DROP TRIGGER wallet_provider_generation_operation_guard'),
    stmt(db, 'DROP TRIGGER wallet_provider_generation_binding_guard'),
    stmt(
      db,
      `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision,
       pass_credential_generation, lifecycle_generation, issuing_release_id, projection_release_id,
       account_revision, adapter_revision, policy_revision, created_at, credential_keyset_commitment)
      SELECT ?, i.id, 1, 'upsert', ?, p.version, p.revision, p.credential_generation,
        p.lifecycle_generation, p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision, ?, i.credential_keyset_commitment
      FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id AND p.org_id = i.org_id AND p.mode = i.mode
      JOIN wallet_provider_accounts a ON a.id = ? AND a.org_id = i.org_id AND a.mode = i.mode
        AND a.provider = i.provider AND a.credential_id IS NOT NULL AND a.revoked_at IS NULL
      JOIN template_releases r ON r.id = ? AND r.org_id = i.org_id AND r.mode = i.mode AND r.provider = i.provider
        AND r.template_id = p.template_id AND r.version = p.template_version AND r.source = 'approved'
      JOIN template_candidates c ON c.id = r.candidate_id AND c.source_release_id = p.release_id
        AND c.provider_account_id = a.id AND c.provider_account_revision = a.revision
      WHERE i.id = ? AND i.lifecycle = 'ready' AND i.credential_generation = p.credential_generation`,
      [operationId, requestHash, now, accountId, releaseId, instanceId],
    ),
    stmt(
      db,
      `UPDATE wallet_provider_instances SET lifecycle = 'active', account_id = ?,
      identity_projection_release_id = ?, desired_version = 1, desired_operation_id = ?, updated_at = ?
      WHERE id = ? AND lifecycle = 'ready'`,
      [accountId, releaseId, operationId, now, instanceId],
    ),
    stmt(db, operationGuard),
    stmt(db, bindingGuard),
  ]);
  if (results[2]?.meta.changes !== 1 || results[3]?.meta.changes !== 1)
    throw new Error('Historical structural activation failed');
  return operationId;
}

describe('provider credential generation transitions', () => {
  it('holds a transfer behind uncertain old work, retires the old identity, and keeps new offers unavailable', async () => {
    const f = await setupSamsungCallbacks();
    const db = f.kit.env.DB;
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, f.kit.env);
    const scope = {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung' as const,
      credentialKeysetCommitment,
    };
    const oldClaim = {
      ...scope,
      instanceId: f.operation.instanceId,
      version: f.operation.version,
      claimHandle: newWalletClaimHandle(),
      now: f.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, oldClaim)).toBe('claimed');
    const oldToken = f.pass.downloadToken;
    const oldRefHash = await sha256Hex(f.refId);
    const wrapper = f.kit.ctx.ids.token(32);
    const wrapperHash = await sha256Hex(wrapper);
    await seedHistoricalOfferRef(db, {
      refHash: wrapperHash,
      instanceId: f.operation.instanceId,
      operationVersion: f.operation.version,
      createdAt: oldClaim.now,
      expiresAt: oldClaim.now + 300_000,
      consumedAt: null,
      deliveredAt: null,
    });
    expect((await f.call({ token: await f.token() })).status).toBe(200);

    const transfer = await startCredentialTransfer(
      jobCtxOf(f.kit),
      { type: 'system', id: null },
      f.pass.id,
      { holderEmail: 'new-holder@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: f.pass },
    );
    expect(transfer.state).toBe('pending');
    expect(await markWalletClaimUncertain(db, oldClaim)).toBe(true);
    await expect(passForToken(f.kit.ctx, oldToken)).rejects.toMatchObject({ status: 404 });
    expect((await f.call({ token: await f.token() })).status).not.toBe(200);
    expect(
      await consumeWalletOfferRef(db, wrapper, f.kit.clock.now(), credentialKeysetCommitment),
    ).toBeNull();
    expect(
      await first(db, 'SELECT consumed_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
        wrapperHash,
      ]),
    ).toEqual({ consumed_at: null });
    expect(await getWalletInstance(db, { ...scope, passId: f.pass.id })).toBeNull();
    const staged = await all<{
      provider: string;
      lifecycle: string;
      credential_generation: number;
    }>(
      db,
      `SELECT provider, lifecycle, credential_generation FROM wallet_provider_instances
       WHERE pass_id = ? AND credential_generation = ? ORDER BY provider`,
      [f.pass.id, f.operation.credentialGeneration + 1],
    );
    expect(staged).toEqual([
      {
        provider: 'google',
        lifecycle: 'blocked',
        credential_generation: f.operation.credentialGeneration + 1,
      },
      {
        provider: 'samsung',
        lifecycle: 'blocked',
        credential_generation: f.operation.credentialGeneration + 1,
      },
    ]);
    expect((await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).state).toBe(
      'pending',
    );

    const old = await getWalletInstanceById(db, { ...scope, instanceId: f.operation.instanceId });
    if (!old) throw new Error('Missing retiring provider identity');
    expect(await reconcileWalletInstance(f.kit.ctx, old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(db, { ...scope, instanceId: old.id });
    if (!retiring) throw new Error('Missing desired revocation');
    const revoke = await getWalletOperation(db, {
      ...scope,
      instanceId: old.id,
      version: retiring.desiredVersion,
    });
    if (!revoke) throw new Error('Missing revoke operation');
    expect(revoke).toMatchObject({
      kind: 'revoke',
      credentialGeneration: f.operation.credentialGeneration,
      passCredentialGeneration: f.operation.credentialGeneration + 1,
    });
    const revokeClaim = {
      ...scope,
      instanceId: old.id,
      version: revoke.version,
      claimHandle: newWalletClaimHandle(),
      now: f.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, revokeClaim)).toBe('not_claimable');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...oldClaim,
        now: f.kit.clock.now(),
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('superseded');
    expect(await claimWalletOperation(db, revokeClaim)).toBe('claimed');
    expect(
      await completeWalletOperation(f.kit.ctx, {
        ...revokeClaim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(
      await persistSamsungTombstone(f.kit.ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        instanceId: old.id,
        operationVersion: revoke.version,
        credentialKeysetCommitment,
      }),
    ).toBe(true);
    const wrongEnv = {
      ...f.kit.env,
      KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(113))),
    };
    const wrongCommitment = await credentialRefKeysetCommitment(wrongEnv);
    expect(wrongCommitment).not.toBe(credentialKeysetCommitment);
    await expect(ensureCredentialRefKeyset(db, wrongEnv)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    const beforeMismatch = await first(db, 'SELECT * FROM wallet_provider_instances WHERE id = ?', [
      old.id,
    ]);
    const operationsBeforeMismatch = await all(
      db,
      'SELECT * FROM wallet_provider_instance_operations WHERE instance_id = ? ORDER BY version',
      [old.id],
    );
    const refsBeforeMismatch = await all(
      db,
      'SELECT * FROM wallet_samsung_fetch_refs WHERE instance_id = ?',
      [old.id],
    );
    const tombstoneBeforeMismatch = await first(
      db,
      'SELECT * FROM wallet_samsung_tombstones WHERE ref_hash = ?',
      [oldRefHash],
    );
    expect(
      await retireWalletInstance(db, {
        ...revokeClaim,
        credentialKeysetCommitment: wrongCommitment,
        now: f.kit.clock.now(),
      }),
    ).toBe(false);
    expect(
      await first(db, 'SELECT * FROM wallet_provider_instances WHERE id = ?', [old.id]),
    ).toEqual(beforeMismatch);
    expect(
      await all(
        db,
        'SELECT * FROM wallet_provider_instance_operations WHERE instance_id = ? ORDER BY version',
        [old.id],
      ),
    ).toEqual(operationsBeforeMismatch);
    expect(
      await all(db, 'SELECT * FROM wallet_samsung_fetch_refs WHERE instance_id = ?', [old.id]),
    ).toEqual(refsBeforeMismatch);
    expect(
      await first(db, 'SELECT * FROM wallet_samsung_tombstones WHERE ref_hash = ?', [oldRefHash]),
    ).toEqual(tombstoneBeforeMismatch);
    expect(await retireWalletInstance(db, { ...revokeClaim, now: f.kit.clock.now() })).toBe(true);
    expect(
      await first(db, 'SELECT ref_hash FROM wallet_samsung_tombstones WHERE ref_hash = ?', [
        oldRefHash,
      ]),
    ).toEqual({ ref_hash: oldRefHash });

    expect((await finishCredentialTransfer(jobCtxOf(f.kit), transfer.transferId)).state).toBe(
      'completed',
    );
    const next = await getWalletInstance(db, { ...scope, passId: f.pass.id });
    if (!next) throw new Error('Missing target provider placeholder');
    expect(next).toMatchObject({
      lifecycle: 'ready',
      credentialGeneration: f.operation.credentialGeneration + 1,
      accountId: null,
      installationState: 'unknown',
    });
    expect(next.id).not.toBe(old.id);
    const currentPass = await getPass(db, f.pass.id);
    const snapshot = await readWalletPassSnapshot(db, { ...scope, passId: f.pass.id });
    if (!currentPass?.releaseId || !snapshot) throw new Error('Missing transferred pass');
    const approved = await getApprovedProjection(
      f.kit.ctx,
      {
        ...scope,
        templateId: currentPass.templateId,
        templateVersion: currentPass.templateVersion,
        appleReleaseId: currentPass.releaseId,
      },
      { credentialKeysetCommitment },
    );
    if (!approved) throw new Error('Missing independently reviewed Samsung projection');
    const policy = projectionPolicy('samsung');
    expect(
      await whileDisabledForTest(createWalletInstance, db, {
        ...scope,
        passId: currentPass.id,
        passVersion: snapshot.passVersion,
        passRevision: snapshot.passRevision,
        passCredentialGeneration: snapshot.credentialGeneration,
        lifecycleGeneration: snapshot.lifecycleGeneration,
        issuingReleaseId: snapshot.issuingReleaseId,
        projectionReleaseId: approved.release.id,
        accountId: approved.release.accountId,
        accountRevision: approved.release.accountRevision,
        adapterRevision: policy.adapterRevision,
        policyRevision: policy.audiencePolicyRevision,
        instanceId: next.id,
        requestKey: crypto.randomUUID(),
        newId: () => crypto.randomUUID(),
        now: f.kit.clock.now(),
      }),
    ).toBeNull();
    await expect(
      issueWalletOffer(f.kit.ctx, currentPass.downloadToken, 'samsung'),
    ).rejects.toMatchObject({ status: 404 });
    expect(await listWalletOffers(f.kit.ctx, currentPass.id)).toEqual([]);

    // Demonstrate the post-retirement structural binding without authorizing any real offer.
    const operationId = await seedReadyActivation({
      db,
      instanceId: next.id,
      accountId: approved.release.accountId,
      releaseId: approved.release.id,
      now: f.kit.clock.now(),
    });
    const activated = await getWalletInstance(db, { ...scope, passId: currentPass.id });
    expect(activated).toMatchObject({
      id: next.id,
      lifecycle: 'active',
      credentialGeneration: snapshot.credentialGeneration,
      desiredOperationId: operationId,
      installationState: 'unknown',
    });
    expect(
      await whileDisabledForTest(createWalletOfferRef, db, {
        ...scope,
        instanceId: next.id,
        version: 1,
        authority: { kind: 'download', token: currentPass.downloadToken },
        now: f.kit.clock.now(),
      }),
    ).toBeNull();
    expect((await f.call({ token: await f.token() })).status).toBe(204);
    await expect(passForToken(f.kit.ctx, oldToken)).rejects.toMatchObject({ status: 404 });
  }, 120_000);
});
