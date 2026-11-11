import { importPKCS8 } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import {
  finishCredentialTransfer,
  startCredentialTransfer,
} from '../passes/credential-transfer.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import {
  configureWalletProviderAccount,
  getWalletProviderReadiness,
  revokeWalletProviderAccount,
} from './account-service.ts';
import { ensureSamsungFetchRef } from './callbacks-ref.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { persistSamsungTombstone } from './callbacks-tombstone.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstance,
  getWalletInstanceById,
  newWalletClaimHandle,
  queueWalletOperation,
  readWalletPassSnapshot,
  requestWalletRetirement,
  retireWalletInstance,
} from './instance.ts';
import { onWalletPassRetired, reconcileWalletInstance } from './lifecycle.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { putSamsungFetchRef } from './repo-callbacks.ts';
import {
  claimSamsungTombstoneReplay,
  findSamsungTombstones,
  putSamsungTombstone,
  samsungTombstoneStillDeleted,
} from './repo-callbacks-tombstone.ts';
import { providerRetirementCompleteSql, providerRetirementPending } from './repo-sync-retention.ts';
import {
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from './runtime-historical-fixtures.ts';
import { finishWalletProviderRetirement } from './sync-operation-retirement.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('Samsung tombstone retention', () => {
  it('authenticates a no-content response after pass deletion and account rotation or revoke', async () => {
    const t = await setupSamsungCallbacks();
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const db = t.kit.env.DB;
    const providerScope = {
      orgId: t.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const scope = {
      ...providerScope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const instance = await getWalletInstance(db, { ...scope, passId: t.pass.id });
    const pass = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    if (!instance || !pass) throw new Error('Missing retirement fixture');
    expect(
      await requestWalletRetirement(db, {
        ...scope,
        instanceId: instance.id,
        version: instance.desiredVersion,
        now: t.kit.clock.now(),
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        lifecycleGeneration: pass.lifecycleGeneration,
        issuingReleaseId: pass.issuingReleaseId,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    ).toBe(true);
    expect(
      (
        await onWalletPassRetired(t.kit.ctx, {
          orgId: scope.orgId,
          mode: scope.mode,
          passId: pass.passId,
          passVersion: pass.passVersion,
          passRevision: pass.passRevision,
          lifecycleGeneration: pass.lifecycleGeneration,
          passCredentialGeneration: pass.credentialGeneration,
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
        })
      ).scheduled,
    ).toBe(1);
    const retiring = await getWalletInstance(db, { ...scope, passId: t.pass.id });
    if (!retiring) throw new Error('Missing revoke operation');
    const claim = {
      ...scope,
      instanceId: retiring.id,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    const tombstoneScope = {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId: retiring.id,
      operationVersion: retiring.desiredVersion,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const original = await first<{ provider_identity_hash: string }>(
      db,
      `SELECT candidate.provider_identity_hash FROM wallet_provider_instances i
      JOIN template_releases projection_release ON projection_release.id = i.identity_projection_release_id
      JOIN template_candidates candidate ON candidate.id = projection_release.candidate_id WHERE i.id = ?`,
      [retiring.id],
    );
    if (!original) throw new Error('Missing original projection identity');
    const wrongIdentityHash = (
      original.provider_identity_hash === '0'.repeat(64) ? '1' : '0'
    ).repeat(64);
    const wrongKeyset = (t.credentialKeysetCommitment === '0'.repeat(64) ? '1' : '0').repeat(64);
    // Neither an unrelated identity nor an incorrect keyset/version may publish or complete retirement.
    expect(
      await putSamsungTombstone(db, tombstoneScope, wrongIdentityHash, t.kit.clock.now()),
    ).toBe(false);
    expect(
      await putSamsungTombstone(
        db,
        { ...tombstoneScope, credentialKeysetCommitment: wrongKeyset },
        original.provider_identity_hash,
        t.kit.clock.now(),
      ),
    ).toBe(false);
    expect(
      await putSamsungTombstone(
        db,
        { ...tombstoneScope, operationVersion: tombstoneScope.operationVersion + 1 },
        original.provider_identity_hash,
        t.kit.clock.now(),
      ),
    ).toBe(false);
    expect(
      await first(db, 'SELECT COUNT(*) AS count FROM wallet_samsung_tombstones WHERE org_id = ?', [
        scope.orgId,
      ]),
    ).toEqual({ count: 0 });
    expect(
      await first(db, 'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE id = ?', [
        t.referenceId,
      ]),
    ).toEqual({ retired_at: null });
    expect(await persistSamsungTombstone(t.kit.ctx, tombstoneScope)).toBe(true);
    expect(
      await first(db, 'SELECT retired_at FROM wallet_samsung_fetch_refs WHERE id = ?', [
        t.referenceId,
      ]),
    ).toEqual({ retired_at: t.kit.clock.now() });
    const originalTombstones = await all(
      db,
      'SELECT * FROM wallet_samsung_tombstones WHERE org_id = ?',
      [scope.orgId],
    );
    t.kit.clock.advance(1);
    expect(await persistSamsungTombstone(t.kit.ctx, tombstoneScope)).toBe(true);
    expect(
      await all(db, 'SELECT * FROM wallet_samsung_tombstones WHERE org_id = ?', [scope.orgId]),
    ).toEqual(originalTombstones);
    expect(await retireWalletInstance(db, { ...claim, now: t.kit.clock.now() })).toBe(true);
    const stored = await all<Record<string, unknown>>(
      db,
      'SELECT * FROM wallet_samsung_tombstones WHERE org_id = ?',
      [scope.orgId],
    );
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(t.refId);
    expect(JSON.stringify(stored)).not.toContain(t.samsung.partnerPrivateKeyPem);
    expect(JSON.stringify(stored)).not.toContain('Alex Morgan');
    await run(db, 'DELETE FROM passes WHERE id = ?', [t.pass.id]);
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [retiring.id]),
    ).toBeNull();

    const identity = await createFixtureIdentity(undefined, { now: new Date(t.kit.clock.now()) });
    const readiness = await getWalletProviderReadiness(t.kit.ctx, providerScope);
    await configureWalletProviderAccount(t.kit.ctx, t.auth, {
      ...providerScope,
      expectedRevision: readiness.revision,
      credentials: {
        ...t.samsung,
        partnerPrivateKeyPem: identity.privateKey,
        partnerCertificatePem: identity.certificate,
        samsungCertificatePem: identity.certificate,
      },
    });
    const historical = await t.token();
    const response = await t.call({ token: historical });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect((await t.call({ token: historical })).status).toBe(401);
    const changed = await getWalletProviderReadiness(t.kit.ctx, providerScope);
    await revokeWalletProviderAccount(t.kit.ctx, t.auth, {
      ...providerScope,
      expectedRevision: changed.revision,
    });
    expect((await t.call({ token: await t.token() })).status).toBe(204);
    const refHash = await sha256Hex(t.refId);
    const tombstones = await findSamsungTombstones(db, refHash, t.credentialKeysetCommitment);
    const tombstone = tombstones[0];
    if (!tombstone) throw new Error('Missing historical tombstone');
    const oldKey = t.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const newCommitment = await credentialRefKeysetCommitment({ ...t.kit.env, KEK_V1: newKey });
    try {
      await replaceCallbackKeysetForTest(db, newCommitment);
      t.kit.env.KEK_V1 = newKey;
      expect(await findSamsungTombstones(db, refHash, newCommitment)).toEqual([]);
      expect(await samsungTombstoneStillDeleted(db, tombstone)).toBe(false);
      const now = t.kit.clock.now();
      expect(
        await claimSamsungTombstoneReplay(db, tombstone, {
          tokenHash: 'Z'.repeat(43),
          claimId: t.kit.ctx.ids.id(),
          now,
          expiresAt: now + 30_000,
        }),
      ).toBe(false);
      expect(
        await first(db, 'SELECT token_hash FROM wallet_samsung_auth_replays WHERE token_hash = ?', [
          'Z'.repeat(43),
        ]),
      ).toBeNull();
      expect((await t.call({ token: await t.token() })).status).toBe(401);
      await replaceCallbackKeysetForTest(db, null);
      expect((await t.call({ token: await t.token() })).status).toBe(503);
    } finally {
      t.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
    expect((await t.call({ token: await t.token() })).status).toBe(204);
  }, 120_000);

  it('retains independently verified historical certificates for the same instance after rotation', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const providerScope = {
      orgId: t.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const scope = {
      ...providerScope,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const rotatedIdentity = await createFixtureIdentity(undefined, {
      now: new Date(t.kit.clock.now()),
    });
    const account = await getWalletProviderReadiness(t.kit.ctx, providerScope);
    await configureWalletProviderAccount(t.kit.ctx, t.auth, {
      ...providerScope,
      expectedRevision: account.revision,
      credentials: {
        ...t.samsung,
        partnerPrivateKeyPem: rotatedIdentity.privateKey,
        partnerCertificatePem: rotatedIdentity.certificate,
        samsungCertificatePem: rotatedIdentity.certificate,
      },
    });
    const release = await t.publish('samsung', 1);
    const current = await getWalletProviderReadiness(t.kit.ctx, providerScope);
    const updated = await queueWalletOperation(db, {
      ...t.operation,
      kind: 'upsert',
      expectedVersion: t.operation.version,
      accountRevision: current.revision,
      projectionReleaseId: release.id,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!updated) throw new Error('Missing historical upsert fixture');
    // Model a previously accepted provider operation without contacting an actual provider.
    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'succeeded', completed_at = ? WHERE id = ?",
      [t.kit.clock.now(), updated.id],
    );
    const revoke = await queueWalletOperation(db, {
      ...updated,
      kind: 'revoke',
      expectedVersion: updated.version,
      projectionReleaseId: t.operation.identityProjectionReleaseId,
      requestKey: t.kit.ctx.ids.token(32),
      newId: () => crypto.randomUUID(),
      now: t.kit.clock.now(),
    });
    if (!revoke) throw new Error('Missing historical revoke fixture');
    const claim = {
      ...scope,
      instanceId: revoke.instanceId,
      version: revoke.version,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    const tombstoneScope = {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId: revoke.instanceId,
      operationVersion: revoke.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    expect(await persistSamsungTombstone(t.kit.ctx, tombstoneScope)).toBe(true);
    const tombstoneQuery = `SELECT ref_hash, account_revision, candidate_id, release_id,
      provider_identity_hash, retired_at, credential_keyset_commitment
      FROM wallet_samsung_tombstones WHERE org_id = ? ORDER BY account_revision`;
    const rows = await all<{
      ref_hash: string;
      account_revision: number;
      candidate_id: string;
      release_id: string;
      provider_identity_hash: string;
      retired_at: number;
      credential_keyset_commitment: string;
    }>(db, tombstoneQuery, [scope.orgId]);
    expect(rows.map((row) => row.account_revision)).toEqual([account.revision, current.revision]);
    expect(rows.map((row) => row.release_id)).toEqual([
      t.operation.identityProjectionReleaseId,
      release.id,
    ]);
    expect(rows.map((row) => row.candidate_id)).toEqual([
      t.samsungRelease?.candidateId,
      release.candidateId,
    ]);
    const refHash = await sha256Hex(t.refId);
    expect(rows.every((row) => row.ref_hash === refHash)).toBe(true);
    expect(rows[0]?.provider_identity_hash).toBe(rows[1]?.provider_identity_hash);
    expect(
      rows.every((row) => row.credential_keyset_commitment === t.credentialKeysetCommitment),
    ).toBe(true);
    t.kit.clock.advance(1);
    expect(await persistSamsungTombstone(t.kit.ctx, tombstoneScope)).toBe(true);
    expect(await all(db, tombstoneQuery, [scope.orgId])).toEqual(rows);
    expect((await t.call({ token: await t.token() })).status).toBe(204);
    const newKey = (await importPKCS8(rotatedIdentity.privateKey, 'RS256')) as CryptoKey;
    expect((await t.call({ token: await t.token({ signingKey: newKey }) })).status).toBe(204);
  }, 120_000);

  it('never reuses a tombstoned ref hash after the original pass is purged', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const pass = await readWalletPassSnapshot(db, { ...scope, passId: t.pass.id });
    if (!pass) throw new Error('Missing retirement fixture');
    expect(
      await requestWalletRetirement(db, {
        ...scope,
        instanceId: t.operation.instanceId,
        version: t.operation.version,
        now: t.kit.clock.now(),
        passVersion: pass.passVersion,
        passRevision: pass.passRevision,
        lifecycleGeneration: pass.lifecycleGeneration,
        issuingReleaseId: pass.issuingReleaseId,
        passCredentialGeneration: pass.credentialGeneration,
      }),
    ).toBe(true);
    expect(
      (
        await onWalletPassRetired(t.kit.ctx, {
          orgId: scope.orgId,
          mode: scope.mode,
          passId: pass.passId,
          passVersion: pass.passVersion,
          passRevision: pass.passRevision,
          lifecycleGeneration: pass.lifecycleGeneration,
          passCredentialGeneration: pass.credentialGeneration,
          credentialKeysetCommitment: pass.credentialKeysetCommitment,
        })
      ).scheduled,
    ).toBe(1);
    const retiring = await getWalletInstance(db, { ...scope, passId: pass.passId });
    if (!retiring) throw new Error('Missing revoke operation');
    const claim = {
      ...scope,
      instanceId: retiring.id,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(
      await persistSamsungTombstone(t.kit.ctx, {
        orgId: scope.orgId,
        mode: scope.mode,
        instanceId: retiring.id,
        operationVersion: retiring.desiredVersion,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      }),
    ).toBe(true);
    expect(await retireWalletInstance(db, claim)).toBe(true);
    await run(db, 'DELETE FROM passes WHERE id = ?', [pass.passId]);

    const nextPass = await t.kit.pass();
    const next = await readWalletPassSnapshot(db, { ...scope, passId: nextPass.id });
    if (!next) throw new Error('Missing new pass fixture');
    const operation = await seedHistoricalProviderInstance(db, {
      ...scope,
      id: t.kit.ctx.ids.id(),
      operationId: t.kit.ctx.ids.id(),
      passId: next.passId,
      credentialGeneration: next.credentialGeneration,
      accountId: t.operation.accountId,
      releaseId: t.operation.projectionReleaseId,
      now: t.kit.clock.now(),
      upsert: { requestHash: await sha256Hex(t.kit.ctx.ids.token(32)), state: 'pending' },
    });
    if (!operation) throw new Error('Missing new instance fixture');
    const referenceId = t.kit.ctx.ids.id();
    const now = t.kit.clock.now();
    const envelope = await encryptSecret(
      await loadKekRing(t.kit.env),
      t.refId,
      credentialAad(referenceId, scope.orgId, `samsung-ref|${scope.mode}|${operation.instanceId}`),
    );
    const refScope = {
      orgId: scope.orgId,
      mode: scope.mode,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    // Bypass only the test issuance guard to model an old row: the separate immutable
    // tombstone-hash guard must still reject a collision after the original pass is gone.
    await expect(
      seedHistoricalSamsungRef(db, {
        id: referenceId,
        refHash: await sha256Hex(t.refId),
        instanceId: operation.instanceId,
        createdAt: now,
        initialExpiresAt: now + 60_000,
        promotedAt: now,
        envelope,
        credentialKeysetCommitment: t.credentialKeysetCommitment,
      }),
    ).rejects.toThrow();
    expect(
      await putSamsungFetchRef(db, refScope, {
        id: referenceId,
        hash: await sha256Hex(t.refId),
        envelope,
        now,
        expiresAt: now + 60_000,
      }),
    ).toBeNull();
    expect(
      await first(db, 'SELECT id FROM wallet_samsung_fetch_refs WHERE instance_id = ?', [
        operation.instanceId,
      ]),
    ).toBeNull();
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
        ...refScope,
        expiresAt: now + 60_000,
      }),
    ).toBeNull();
    expect((await t.call({ token: await t.token() })).status).toBe(204);
  }, 120_000);

  it('waits for every older incarnation before transfer completion and retains old tombstones', async () => {
    const t = await setupSamsungCallbacks({ holderEmail: 'first@example.test' });
    const db = t.kit.env.DB;
    const scope = {
      orgId: t.pass.orgId,
      mode: t.pass.mode,
      provider: 'samsung' as const,
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    const holder = await getHolderPass(db, t.pass.id, null);
    if (!holder) throw new Error('Missing holder fixture');
    const transfer = await startCredentialTransfer(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      t.pass.id,
      { holderEmail: 'second@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: holder },
    );
    expect(transfer.state).toBe('pending');
    const priorDone = () =>
      first<{ done: number }>(
        db,
        `SELECT CASE WHEN ${providerRetirementCompleteSql('p.id', 'p.credential_generation')}
        THEN 1 ELSE 0 END AS done FROM passes p WHERE p.id = ?`,
        [t.pass.id],
      );
    expect(await priorDone()).toEqual({ done: 0 });
    expect(await providerRetirementPending(db, t.pass.id, t.credentialKeysetCommitment)).toBe(true);
    expect((await finishCredentialTransfer(jobCtxOf(t.kit), transfer.transferId)).state).toBe(
      'pending',
    );

    const old = await getWalletInstanceById(db, scope);
    if (!old) throw new Error('Missing previous incarnation');
    expect(await reconcileWalletInstance(t.kit.ctx, old)).toBe('scheduled');
    const retiring = await getWalletInstanceById(db, scope);
    if (!retiring) throw new Error('Missing revoke operation');
    const claim = {
      ...scope,
      version: retiring.desiredVersion,
      claimHandle: newWalletClaimHandle(),
      now: t.kit.clock.now(),
    };
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    expect(
      await completeWalletOperation(t.kit.ctx, {
        ...claim,
        result: { kind: 'success', httpStatus: 200 },
      }),
    ).toBe('succeeded');
    expect(await priorDone()).toEqual({ done: 0 });
    expect((await finishCredentialTransfer(jobCtxOf(t.kit), transfer.transferId)).state).toBe(
      'pending',
    );
    expect(await finishWalletProviderRetirement(t.kit.ctx, claim)).toBe(true);
    expect(await priorDone()).toEqual({ done: 1 });
    // The blocked target is not an old credential but must still prevent pass purge.
    expect(await providerRetirementPending(db, t.pass.id, t.credentialKeysetCommitment)).toBe(true);
    expect((await finishCredentialTransfer(jobCtxOf(t.kit), transfer.transferId)).state).toBe(
      'completed',
    );
    const current = await getPass(db, t.pass.id);
    if (!current) throw new Error('Missing transferred pass');
    expect(current.credentialGeneration).toBe(t.pass.credentialGeneration + 1);
    expect(current.holderEmail).toBe('second@example.test');
    const oldResponse = await t.call({ token: await t.token() });
    expect(oldResponse.status).toBe(204);
    expect(await oldResponse.text()).toBe('');

    // A further transfer closes both never-issued target placeholders, but purge still waits
    // on the current generation and the original retired instance remains part of the proof.
    const nextHolder = await getHolderPass(db, t.pass.id, null);
    if (!nextHolder) throw new Error('Missing next holder');
    const next = await startCredentialTransfer(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      t.pass.id,
      { holderEmail: 'third@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: nextHolder },
    );
    expect((await finishCredentialTransfer(jobCtxOf(t.kit), next.transferId)).state).toBe(
      'completed',
    );
    expect(await priorDone()).toEqual({ done: 1 });
    expect(await providerRetirementPending(db, t.pass.id, t.credentialKeysetCommitment)).toBe(true);
    const incarnations = await all<{
      credential_generation: number;
      provider: string;
      lifecycle: string;
    }>(
      db,
      `SELECT credential_generation, provider, lifecycle FROM wallet_provider_instances
        WHERE pass_id = ? ORDER BY credential_generation, provider`,
      [t.pass.id],
    );
    expect(incarnations).toContainEqual({
      credential_generation: t.pass.credentialGeneration,
      provider: 'samsung',
      lifecycle: 'retired',
    });
    const intermediate = incarnations.filter(
      (row) => row.credential_generation === current.credentialGeneration,
    );
    expect(intermediate).toHaveLength(2);
    expect(intermediate.every((row) => row.lifecycle === 'retired')).toBe(true);
    expect((await t.call({ token: await t.token() })).status).toBe(204);
  }, 180_000);
});
