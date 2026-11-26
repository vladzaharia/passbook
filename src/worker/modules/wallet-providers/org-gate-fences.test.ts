// WA5: the database refuses what the service gate refuses, for a new-model enrolment that is Off or held.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { holdEnrolment } from './enrolment-hold.ts';
import { enableEnrolment } from './enrolment-service.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';
import { historicalGoogleRelease } from './runtime-integration-fixtures.ts';
import {
  dropInsertGuards,
  enrol,
  platformSource,
  seedInstance,
  sessionFor,
  verificationOf,
} from './wallet-roundtrip-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('enrolment gate in the database and the claim proof', () => {
  it('refuses activation while Off, then follows On and a platform hold', async () => {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'absent',
      holderEmail: 'h@example.test',
    });
    const { kit } = f;
    kit.clock.set(Date.now());
    await dropInsertGuards(env.DB);
    const orgId = kit.org.id;
    const source = await platformSource(f, 'test', '33880000000200001');
    const a = await enrol(f, orgId, 'test', source, false);
    const pass = await kit.pass({ mode: 'test', holderEmail: 'h@example.test' });
    const verification = await verificationOf(f, orgId, 'test', a);

    // Off: the instance cannot be created active.
    await expect(seedInstance(f, pass, a, verification)).rejects.toThrow(/enrolment is not on/);

    // On: it can be created.
    await addCheck(source.id, source.versionId);
    await enableEnrolment(kit.ctx, a.auth, orgId, 'google', { expectedRevision: 1 });
    const on = { ...a, revision: 2 };
    const seeded = await seedInstance(f, pass, on, verification, 2);
    // Held: no offer ref can be added.
    const admin = await sessionFor(f, (await makeUser(kit.fx)).id, ['admin', 'user'], 'test');
    await holdEnrolment(kit.ctx, admin, { orgId, mode: 'test', provider: 'google' }, 'abuse');
    await expect(
      seedHistoricalOfferRef(env.DB, {
        refHash: 'a'.repeat(64),
        instanceId: seeded.instanceId,
        operationVersion: 1,
        createdAt: kit.clock.now(),
        expiresAt: kit.clock.now() + 60_000,
        consumedAt: null,
        deliveredAt: null,
      }),
    ).rejects.toThrow(/enrolment is not on/);
    expect(
      await first(env.DB, 'SELECT 1 FROM wallet_provider_offer_refs WHERE instance_id = ?', [
        seeded.instanceId,
      ]),
    ).toBeNull();

    // Retirement is unaffected by the hold; a restore to active is refused.
    const setLifecycle = (lifecycle: string) =>
      run(env.DB, 'UPDATE wallet_provider_instances SET lifecycle = ? WHERE id = ?', [
        lifecycle,
        seeded.instanceId,
      ]);
    await setLifecycle('revoking');
    await expect(setLifecycle('active')).rejects.toThrow(/enrolment is not on/);
    await setLifecycle('revoked');
    await expect(setLifecycle('active')).rejects.toThrow(/enrolment is not on/);

    // A successor instance (next channel epoch), born active, is refused on the held enrolment too.
    await expect(
      run(
        env.DB,
        `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, account_id,
          identity_projection_release_id, credential_generation, channel_epoch, lifecycle, desired_version,
          desired_operation_id, created_at, updated_at, credential_keyset_commitment)
         SELECT ?, pass_id, org_id, mode, provider, account_id, identity_projection_release_id,
          credential_generation, 2, 'active', desired_version, desired_operation_id, created_at,
          updated_at, credential_keyset_commitment
         FROM wallet_provider_instances WHERE id = ?`,
        [kit.ctx.ids.id(), seeded.instanceId],
      ),
    ).rejects.toThrow(/enrolment is not on/);
  });

  it('leaves a legacy envelope row alone: its instance and offer ref are not gated', async () => {
    const f = await setupWalletOfferKit({
      google: 'configured',
      samsung: 'absent',
      holderEmail: 'old@example.test',
    });
    const { kit, pass } = f;
    const keyset = await requireCredentialRefKeyset(env.DB, kit.env);
    const account = await first<{ id: string; enabled_at: number | null }>(
      env.DB,
      "SELECT id, enabled_at FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'live' AND provider = 'google'",
      [pass.orgId],
    );
    expect(account?.enabled_at).toBeNull();
    const instanceId = kit.ctx.ids.id();
    await seedHistoricalProviderInstance(env.DB, {
      id: instanceId,
      passId: pass.id,
      orgId: pass.orgId,
      mode: 'live',
      provider: 'google',
      credentialGeneration: 1,
      credentialKeysetCommitment: keyset,
      accountId: account?.id ?? '',
      releaseId: await historicalGoogleRelease(f),
      operationId: kit.ctx.ids.id(),
      now: kit.clock.now(),
      upsert: { requestHash: await sha256Hex('legacy-op'), state: 'succeeded' },
    });
    await seedHistoricalOfferRef(env.DB, {
      refHash: 'b'.repeat(64),
      instanceId,
      operationVersion: 1,
      createdAt: kit.clock.now(),
      expiresAt: kit.clock.now() + 60_000,
      consumedAt: null,
      deliveredAt: null,
    });
    expect(
      await first(env.DB, 'SELECT 1 FROM wallet_provider_offer_refs WHERE instance_id = ?', [
        instanceId,
      ]),
    ).not.toBeNull();
  });
});
