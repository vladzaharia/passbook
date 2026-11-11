import { beforeAll, describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { setupKit } from '../passes/pass-test-fixtures.ts';
import { mapPass, type PassDbRow } from '../passes/repo-map.ts';
import { deletePassRows, expiredDeletedPasses } from '../passes/repo-ops-retention.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { retireUnissuedPlaceholder } from './repo-instance-retirement.ts';
import { ackCleanWalletPlaceholder } from './repo-sync-queue.ts';
import { providerRetirementCompleteSql, providerRetirementPending } from './repo-sync-retention.ts';
import { runtimeGoogleLegacyFixture } from './runtime-integration-fixtures.ts';
import { drainWalletProviderSync } from './sync.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const makeEnv = installKeysetTestEnv();

async function deletedPassSnapshot(db: D1Database, passId: string) {
  const row = await first<PassDbRow>(db, 'SELECT * FROM passes WHERE id = ?', [passId]);
  if (!row || row.deleted_at === null) throw new Error('Missing deleted pass');
  return mapPass(row);
}

async function dirtyGeneration(db: D1Database, instanceId: string) {
  await run(
    db,
    `INSERT INTO wallet_provider_instance_dirty(instance_id, generation, next_attempt_at)
    VALUES (?, 1, 0) ON CONFLICT(instance_id) DO UPDATE SET generation = generation + 1`,
    [instanceId],
  );
  const row = await first<{ generation: number }>(
    db,
    'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
    [instanceId],
  );
  if (!row) throw new Error('Missing dirty placeholder');
  return row.generation;
}

describe('wallet retirement fences', () => {
  it('checks only older credential generations for transfer completion', () => {
    const predicate = providerRetirementCompleteSql('p.id', 'p.credential_generation');
    expect(predicate).toContain('wallet_retention_instance.pass_id = p.id');
    expect(predicate).toContain(
      'wallet_retention_instance.credential_generation < p.credential_generation',
    );
    expect(predicate).toContain("retirement_reason = 'not_issued'");
    expect(predicate).toContain("provider = 'samsung'");
  });

  it('checks every incarnation for pass retention', () => {
    expect(providerRetirementCompleteSql('passes.id')).not.toContain('credential_generation <');
  });

  it('rejects untrusted SQL expressions rather than interpolating them', () => {
    expect(() => providerRetirementCompleteSql('p.id; DROP TABLE passes')).toThrow();
    expect(() => providerRetirementCompleteSql('p.id', '0) OR 1=1 --')).toThrow();
    expect(() => providerRetirementCompleteSql('p.id', '?')).toThrow();
  });

  it('holds purge and direct deletion until the current unissued incarnation is retired', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB });
    const pass = await kit.pass({ holderEmail: 'before@example.test' });
    const db = kit.env.DB;
    const now = kit.clock.now();
    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing holder snapshot');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: 'after@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      ),
    ).toMatchObject({ state: 'completed' });
    const credentialKeysetCommitment = await requireCredentialRefKeyset(db, kit.env);
    const wrongEnv = {
      ...kit.env,
      KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(113))),
    };
    const wrongCommitment = await credentialRefKeysetCommitment(wrongEnv);
    expect(wrongCommitment).not.toBe(credentialKeysetCommitment);
    await expect(ensureCredentialRefKeyset(db, wrongEnv)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    const generation = await first<{ credential_generation: number }>(
      db,
      'SELECT credential_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!generation || generation.credential_generation <= 1)
      throw new Error('Missing advanced credential generation');
    const instances = await all<{ id: string; provider: 'google' | 'samsung' }>(
      db,
      `SELECT id, provider FROM wallet_provider_instances
       WHERE pass_id = ? AND credential_generation = ? AND lifecycle = 'ready' ORDER BY provider`,
      [pass.id, generation.credential_generation],
    );
    expect(instances.map((instance) => instance.provider)).toEqual(['google', 'samsung']);
    const [google, samsung] = instances;
    if (!google || !samsung) throw new Error('Missing completed-transfer provider placeholders');
    const check = (beforeGeneration = false) =>
      first<{ complete: number }>(
        db,
        `SELECT ${providerRetirementCompleteSql('p.id', beforeGeneration ? 'p.credential_generation' : undefined)} AS complete
       FROM passes p WHERE p.id = ?`,
        [pass.id],
      );
    expect(await check()).toEqual({ complete: 0 });
    expect(await check(true)).toEqual({ complete: 1 });
    expect(await providerRetirementPending(db, pass.id, credentialKeysetCommitment)).toBe(true);

    const scope = {
      orgId: pass.orgId,
      mode: pass.mode,
      provider: google.provider,
      instanceId: google.id,
      credentialKeysetCommitment,
    };
    const dirty = await dirtyGeneration(db, google.id);
    expect(
      await ackCleanWalletPlaceholder(db, {
        ...scope,
        credentialKeysetCommitment: wrongCommitment,
        generation: dirty,
      }),
    ).toBe(false);
    expect(await ackCleanWalletPlaceholder(db, { ...scope, generation: dirty - 1 })).toBe(false);
    expect(
      await first(
        db,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [google.id],
      ),
    ).toEqual({ generation: dirty });
    expect(await ackCleanWalletPlaceholder(db, { ...scope, generation: dirty })).toBe(true);
    expect(
      await first(
        db,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [google.id],
      ),
    ).toBeNull();
    const retirementDirty = await dirtyGeneration(db, google.id);
    await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?', [
      now,
      google.id,
    ]);
    expect(await ackCleanWalletPlaceholder(db, { ...scope, generation: retirementDirty })).toBe(
      false,
    );
    expect(
      await first(
        db,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [google.id],
      ),
    ).toEqual({ generation: retirementDirty });

    await run(db, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [now, pass.id]);
    const deletionDirty = await dirtyGeneration(db, samsung.id);
    expect(
      await ackCleanWalletPlaceholder(db, {
        orgId: pass.orgId,
        mode: pass.mode,
        provider: samsung.provider,
        instanceId: samsung.id,
        credentialKeysetCommitment,
        generation: deletionDirty,
      }),
    ).toBe(false);
    expect(
      await first(
        db,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [samsung.id],
      ),
    ).toEqual({ generation: deletionDirty });
    const deletedPass = await deletedPassSnapshot(db, pass.id);
    const retention = await prepareScanRetentionDelete(kit.env, deletedPass);
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === pass.id)).toBe(
      false,
    );
    expect(
      (await deletePassRows(db, deletedPass, retention, credentialKeysetCommitment)).deleted,
    ).toBe(false);
    await expect(
      run(db, 'DELETE FROM wallet_provider_instances WHERE id = ?', [google.id]),
    ).rejects.toThrow();
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [google.id]),
    ).toEqual({ id: google.id });

    const retirement = {
      orgId: pass.orgId,
      mode: pass.mode,
      credentialKeysetCommitment,
      credentialGeneration: generation.credential_generation,
      passCredentialGeneration: generation.credential_generation,
      now,
    };
    expect(
      await retireUnissuedPlaceholder(db, {
        ...retirement,
        instanceId: google.id,
        provider: google.provider,
        passCredentialGeneration: generation.credential_generation + 1,
      }),
    ).toBe(false);
    const beforeMismatch = await first(db, 'SELECT * FROM wallet_provider_instances WHERE id = ?', [
      google.id,
    ]);
    const dirtyBeforeMismatch = await first(
      db,
      'SELECT * FROM wallet_provider_instance_dirty WHERE instance_id = ?',
      [google.id],
    );
    expect(
      await retireUnissuedPlaceholder(db, {
        ...retirement,
        instanceId: google.id,
        provider: google.provider,
        credentialKeysetCommitment: wrongCommitment,
      }),
    ).toBe(false);
    expect(
      await first(db, 'SELECT * FROM wallet_provider_instances WHERE id = ?', [google.id]),
    ).toEqual(beforeMismatch);
    expect(
      await first(db, 'SELECT * FROM wallet_provider_instance_dirty WHERE instance_id = ?', [
        google.id,
      ]),
    ).toEqual(dirtyBeforeMismatch);
    expect(await check()).toEqual({ complete: 0 });
    expect(
      await retireUnissuedPlaceholder(db, {
        ...retirement,
        instanceId: google.id,
        provider: google.provider,
      }),
    ).toBe(true);
    expect(await check()).toEqual({ complete: 0 });
    expect(
      (await deletePassRows(db, deletedPass, retention, credentialKeysetCommitment)).deleted,
    ).toBe(false);
    expect(
      await retireUnissuedPlaceholder(db, {
        ...retirement,
        instanceId: samsung.id,
        provider: samsung.provider,
      }),
    ).toBe(true);
    expect(await check()).toEqual({ complete: 1 });
    expect(await providerRetirementPending(db, pass.id, credentialKeysetCommitment)).toBe(false);
    expect(await providerRetirementPending(db, pass.id, wrongCommitment)).toBe(true);
    const noInstances = await kit.pass();
    expect(await providerRetirementPending(db, noInstances.id, credentialKeysetCommitment)).toBe(
      false,
    );
    expect(await providerRetirementPending(db, noInstances.id, wrongCommitment)).toBe(true);
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === pass.id)).toBe(
      true,
    );
    expect((await deletePassRows(db, deletedPass, retention, wrongCommitment)).deleted).toBe(false);
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toEqual({
      id: pass.id,
    });
    expect(
      (await deletePassRows(db, deletedPass, retention, credentialKeysetCommitment)).deleted,
    ).toBe(true);
  });

  it('does not acknowledge a dirty placeholder belonging to an older credential generation', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB });
    const pass = await kit.pass({ holderEmail: 'first@example.test' });
    const db = kit.env.DB;
    const actor = { type: 'system', id: null } as const;
    const firstHolder = await getHolderPass(db, pass.id, null);
    if (!firstHolder) throw new Error('Missing first holder snapshot');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        actor,
        pass.id,
        { holderEmail: 'second@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected: firstHolder },
      ),
    ).toMatchObject({ state: 'completed' });
    const old = await first<{ id: string }>(
      db,
      `SELECT id FROM wallet_provider_instances
      WHERE pass_id = ? AND provider = 'google' AND lifecycle = 'ready'`,
      [pass.id],
    );
    if (!old) throw new Error('Missing first target placeholder');
    const secondHolder = await getHolderPass(db, pass.id, null);
    if (!secondHolder) throw new Error('Missing second holder snapshot');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        actor,
        pass.id,
        { holderEmail: 'third@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected: secondHolder },
      ),
    ).toMatchObject({ state: 'completed' });
    const dirty = await dirtyGeneration(db, old.id);
    const credentialKeysetCommitment = await requireCredentialRefKeyset(db, kit.env);
    expect(
      await ackCleanWalletPlaceholder(db, {
        orgId: pass.orgId,
        mode: pass.mode,
        provider: 'google',
        instanceId: old.id,
        credentialKeysetCommitment,
        generation: dirty,
      }),
    ).toBe(false);
    expect(
      await first(
        db,
        'SELECT generation FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [old.id],
      ),
    ).toEqual({ generation: dirty });
  });

  it('retains an issued incarnation with an in-flight revoke', async () => {
    const f = await runtimeGoogleLegacyFixture({ db: (await makeEnv()).DB });
    const db = f.kit.env.DB;
    const now = f.kit.clock.now();
    const credentialKeysetCommitment = await requireCredentialRefKeyset(db, f.kit.env);
    await run(db, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [now, f.pass.id]);
    const deletedPass = await deletedPassSnapshot(db, f.pass.id);
    const retention = await prepareScanRetentionDelete(f.kit.env, deletedPass);
    expect(await providerRetirementPending(db, f.pass.id, credentialKeysetCommitment)).toBe(true);
    expect((await expiredDeletedPasses(db, now + 1, '', 100)).some((p) => p.id === f.pass.id)).toBe(
      false,
    );
    expect(
      (await deletePassRows(db, deletedPass, retention, credentialKeysetCommitment)).deleted,
    ).toBe(false);
    await expect(
      run(db, 'DELETE FROM wallet_provider_instances WHERE id = ?', [f.instanceId]),
    ).rejects.toThrow();
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [f.instanceId]),
    ).toEqual({ id: f.instanceId });
  });
});

describe('wallet sync of unissued transfer targets', () => {
  it('acknowledges pristine targets and later retires them without scheduling provider work', async () => {
    const kit = await setupKit({ db: (await makeEnv()).DB });
    const pass = await kit.pass({ holderEmail: 'before@example.test' });
    const db = kit.env.DB;
    const expected = await getHolderPass(db, pass.id, null);
    if (!expected) throw new Error('Missing holder snapshot');
    expect(
      await startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: 'after@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      ),
    ).toMatchObject({ state: 'completed' });
    const instances = await all<{ id: string; provider: string; lifecycle: string }>(
      db,
      `SELECT id, provider, lifecycle FROM wallet_provider_instances
      WHERE pass_id = ? ORDER BY provider`,
      [pass.id],
    );
    expect(instances.map(({ provider, lifecycle }) => ({ provider, lifecycle }))).toEqual([
      { provider: 'google', lifecycle: 'ready' },
      { provider: 'samsung', lifecycle: 'ready' },
    ]);
    for (const instance of instances) await dirtyGeneration(db, instance.id);
    await drainWalletProviderSync(kit.ctx);
    expect(
      await all(
        db,
        `SELECT d.instance_id FROM wallet_provider_instance_dirty d
        JOIN wallet_provider_instances i ON i.id = d.instance_id WHERE i.pass_id = ?`,
        [pass.id],
      ),
    ).toEqual([]);
    expect(
      await all(
        db,
        `SELECT op.id FROM wallet_provider_instance_operations op
        JOIN wallet_provider_instances i ON i.id = op.instance_id WHERE i.pass_id = ?`,
        [pass.id],
      ),
    ).toEqual([]);

    await run(db, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [kit.clock.now(), pass.id]);
    await drainWalletProviderSync(kit.ctx);
    const retired = await all(
      db,
      `SELECT provider, lifecycle, retirement_reason AS reason FROM wallet_provider_instances
      WHERE pass_id = ? ORDER BY provider`,
      [pass.id],
    );
    expect(retired).toEqual([
      { provider: 'google', lifecycle: 'retired', reason: 'not_issued' },
      { provider: 'samsung', lifecycle: 'retired', reason: 'not_issued' },
    ]);
    expect(
      await all(
        db,
        `SELECT d.instance_id FROM wallet_provider_instance_dirty d
        JOIN wallet_provider_instances i ON i.id = d.instance_id WHERE i.pass_id = ?`,
        [pass.id],
      ),
    ).toEqual([]);
    await drainWalletProviderSync(kit.ctx);
    expect(
      await all(
        db,
        `SELECT provider, lifecycle, retirement_reason AS reason FROM wallet_provider_instances
        WHERE pass_id = ? ORDER BY provider`,
        [pass.id],
      ),
    ).toEqual(retired);
  }, 120_000);
});
