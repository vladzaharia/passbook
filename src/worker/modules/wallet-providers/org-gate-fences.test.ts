// WA5: the database refuses what the service gate refuses, for a new-model enrolment that is Off or held.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeUser } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { holdEnrolment } from './enrolment-hold.ts';
import { enableEnrolment } from './enrolment-service.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';
import { seedHistoricalOfferRef } from './runtime-historical-fixtures.ts';
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
  });
});
