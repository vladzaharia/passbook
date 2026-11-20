// WA5, Samsung: the promoted-refresh read and the 0117 ref-insert trigger follow the enrolment.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import {
  readConfiguredWalletProviderCredentials,
  readSamsungPromotedRefreshCredentials,
} from './account-credential-read.ts';
import { holdEnrolment } from './enrolment-hold.ts';
import { disableEnrolment, enableEnrolment } from './enrolment-service.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { runtimeSamsungLegacyFixture } from './runtime-samsung-integration-fixtures.ts';
import { createSamsungRefId } from './samsung.ts';
import {
  dropInsertGuards,
  enrol,
  platformSource,
  seedInstance,
  sessionFor,
} from './wallet-roundtrip-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('Samsung promoted refresh', () => {
  it('stops when the platform holds the enrolment', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      refHash: f.refHash,
      operationVersion: f.version,
    };
    expect(await readSamsungPromotedRefreshCredentials(f.kit.ctx, proof)).not.toBeNull();
    for (const { name } of await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_provider_accounts'",
    ))
      await run(env.DB, `DROP TRIGGER ${name}`);
    await run(
      env.DB,
      "UPDATE wallet_provider_accounts SET platform_hold_at = ? WHERE org_id = ? AND mode = ? AND provider = 'samsung'",
      [f.kit.clock.now(), proof.orgId, proof.mode],
    );
    expect(await readSamsungPromotedRefreshCredentials(f.kit.ctx, proof)).toBeNull();
  });
});

describe('Samsung and the plan', () => {
  it('the refresh and the probe read nothing while the plan lacks Samsung Wallet, and read again on upgrade', async () => {
    const f = await runtimeSamsungLegacyFixture('refresh');
    const proof = {
      orgId: f.scope.orgId,
      mode: f.scope.mode,
      accountId: f.scope.accountId,
      accountRevision: f.scope.accountRevision,
      projectionReleaseId: f.scope.providerReleaseId,
      instanceId: f.instanceId,
      refHash: f.refHash,
      operationVersion: f.version,
    };
    const scope = { orgId: proof.orgId, mode: proof.mode, provider: 'samsung' as const };
    const expected = { accountId: proof.accountId, accountRevision: proof.accountRevision };
    const plan = (preset: string) =>
      run(env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [preset, proof.orgId]);
    expect(await readSamsungPromotedRefreshCredentials(f.kit.ctx, proof)).not.toBeNull();
    expect(
      await readConfiguredWalletProviderCredentials(f.kit.ctx, scope, expected),
    ).not.toBeNull();
    await plan('trial');
    expect(await readSamsungPromotedRefreshCredentials(f.kit.ctx, proof)).toBeNull();
    expect(await readConfiguredWalletProviderCredentials(f.kit.ctx, scope, expected)).toBeNull();
    await plan('legacy');
    expect(await readSamsungPromotedRefreshCredentials(f.kit.ctx, proof)).not.toBeNull();
    expect(
      await readConfiguredWalletProviderCredentials(f.kit.ctx, scope, expected),
    ).not.toBeNull();
  });
});

describe('Samsung fetch-ref trigger', () => {
  it('refuses a new-model enrolment that is Off and allows it when On', async () => {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'absent',
      holderEmail: 'h@example.test',
    });
    const { kit } = f;
    kit.clock.set(Date.now());
    await dropInsertGuards(env.DB);
    const source = await platformSource(f, 'test', 'card991', 'samsung');
    const off = await enrol(f, kit.org.id, 'test', source, false, 'samsung');
    const pass = await kit.pass({ mode: 'test', holderEmail: 'h@example.test' });
    await expect(seedInstance(f, pass, off, null, 1, 'samsung')).rejects.toThrow(
      /enrolment is not on/,
    );

    // On: the instance and a ref go in.
    await addCheck(source.id, source.versionId);
    await enableEnrolment(kit.ctx, off.auth, kit.org.id, 'samsung', { expectedRevision: 1 });
    const on = { ...off, revision: 2 };
    const seeded = await seedInstance(f, pass, on, null, 2, 'samsung');
    const keyset = await requireCredentialRefKeyset(env.DB, kit.env);
    // The 0043 guard refuses every ref while providers are dark; only the WA5 trigger is under test.
    await run(env.DB, 'DROP TRIGGER wallet_provider_generation_samsung_ref');
    const addRef = async () => {
      const refId = createSamsungRefId();
      const id = crypto.randomUUID();
      const now = kit.clock.now();
      const envelope = await encryptSecret(
        await loadKekRing(kit.env),
        refId,
        credentialAad(id, kit.org.id, `samsung-ref|test|${seeded.instanceId}`),
      );
      await run(
        env.DB,
        `INSERT INTO wallet_samsung_fetch_refs (id, ref_hash, instance_id, created_at, last_offered_at,
          initial_expires_at, promoted_at, credential_keyset_commitment, credential_version_id,
          kek_version, iv, wrapped_dek, ciphertext)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          await sha256Hex(refId),
          seeded.instanceId,
          now,
          now,
          now + 60_000,
          now,
          keyset,
          source.versionId,
          envelope.kekVersion,
          envelope.iv,
          envelope.wrappedDek,
          envelope.ciphertext,
        ],
      );
    };
    await addRef();
    expect(
      await all(env.DB, 'SELECT 1 FROM wallet_samsung_fetch_refs WHERE instance_id = ?', [
        seeded.instanceId,
      ]),
    ).toHaveLength(1);

    // Off: no further ref.
    await disableEnrolment(kit.ctx, off.auth, kit.org.id, 'samsung', { expectedRevision: 2 });
    await expect(addRef()).rejects.toThrow(/enrolment is not on/);
    // Held (the hold also leaves it Off): still no ref.
    const admin = await sessionFor(f, (await makeUser(kit.fx)).id, ['admin', 'user'], 'test');
    await holdEnrolment(
      kit.ctx,
      admin,
      { orgId: kit.org.id, mode: 'test', provider: 'samsung' },
      'abuse',
    );
    await expect(addRef()).rejects.toThrow(/enrolment is not on/);
    expect(
      await all(env.DB, 'SELECT 1 FROM wallet_samsung_fetch_refs WHERE instance_id = ?', [
        seeded.instanceId,
      ]),
    ).toHaveLength(1);
  });
});
