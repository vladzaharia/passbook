import { beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import type { Actor } from '../../platform/context.ts';
import { first, run } from '../../platform/db.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { startPlatformProvision } from './run-start.ts';
import { deleteIdentity, listOrgIdentities, updateIdentity, uploadIdentity } from './service.ts';

const actor: Actor = { type: 'system', id: null };
let kit: Kit;

const credential = (id: string) =>
  run(
    kit.env.DB,
    "INSERT INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES (?, 'pass_signer', 1, x'00', x'00', x'00', 1)",
    [`cred-${id}`],
  );

async function slotRow(id: string, passType: string, purpose: 'passes' | 'device_test') {
  await credential(id);
  await run(
    kit.env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, provenance, purpose, is_default, issuing, created_at)
     VALUES (?, NULL, ?, ?, 'TEAM123456', 'db', ?, 'platform', ?, 0, 1, 1)`,
    [id, id, passType, `cred-${id}`, purpose],
  );
}

beforeEach(async () => {
  kit = await setupKit();
  await run(kit.env.DB, "DELETE FROM signing_identities WHERE id LIKE 'slot-%'");
  await run(kit.env.DB, "DELETE FROM credentials WHERE id LIKE 'cred-slot-%'");
});

describe('platform slot rows', () => {
  it('M1: refuses the default on a device_test row and any default, binding or rotation change on platform rows', async () => {
    await slotRow('slot-dev', 'pass.mobile.passbook.devtest', 'device_test');
    await slotRow('slot-root', 'pass.mobile.passbook', 'passes');
    for (const id of ['slot-dev', 'slot-root'])
      for (const patch of [
        { isDefault: true },
        { apnsBinding: 'APNS_X' },
        { rotation: 'manual' as const },
      ])
        await expect(updateIdentity(kit.ctx, actor, id, patch)).rejects.toMatchObject({
          code: 'IDENTITY_PROTECTED',
        });
    await expect(
      updateIdentity(kit.ctx, actor, 'slot-root', { label: 'Root', issuing: false }),
    ).resolves.toMatchObject({ label: 'Root' });
    expect(
      await first(kit.env.DB, "SELECT is_default FROM signing_identities WHERE id = 'slot-dev'"),
    ).toEqual({
      is_default: 0,
    });
  });

  it('M1: still lets the default move between ordinary identities and leaves the legacy row alone', async () => {
    await expect(
      updateIdentity(kit.ctx, actor, 'platform', { nfcEnabled: false }),
    ).resolves.toBeTruthy();
  });

  it('L3: refuses to delete a platform row', async () => {
    await slotRow('slot-root', 'pass.mobile.passbook', 'passes');
    await expect(deleteIdentity(kit.ctx, actor, 'slot-root')).rejects.toMatchObject({
      code: 'IDENTITY_PROTECTED',
    });
    expect(
      await first(kit.env.DB, "SELECT id FROM signing_identities WHERE id = 'slot-root'"),
    ).not.toBeNull();
  });

  it('L4: refuses to upload either platform pass type', async () => {
    for (const passTypeIdentifier of ['pass.mobile.passbook', 'pass.mobile.passbook.devtest']) {
      const f = await createFixtureIdentity({ passTypeIdentifier, teamIdentifier: 'ACME123456' });
      const own = await setupKit({
        clockStart: Date.now(),
        env: { SIGNER_PLATFORM_INTERMEDIATE: f.intermediate },
      });
      await expect(
        uploadIdentity(own.ctx, actor, {
          label: 'Mine',
          certificatePem: f.certificate,
          privateKeyPem: f.privateKey,
        }),
      ).rejects.toMatchObject({ code: 'IDENTITY_PROTECTED' });
    }
  });

  it('L5: rejects an inherited property as a slot', async () => {
    for (const slot of ['__proto__', 'constructor'])
      await expect(
        startPlatformProvision(kit.ctx, { slot: slot as 'root', createdBy: null }),
      ).rejects.toMatchObject({ status: 422 });
    expect(
      await first(kit.env.DB, "SELECT id FROM identity_runs WHERE target_id LIKE 'platform:_%'"),
    ).toBeNull();
  });

  it('L7: purpose cannot change after insert', async () => {
    await slotRow('slot-dev', 'pass.mobile.passbook.devtest', 'device_test');
    await expect(
      run(kit.env.DB, "UPDATE signing_identities SET purpose = 'passes' WHERE id = 'slot-dev'"),
    ).rejects.toThrow(/immutable/);
  });

  it('L7: the member list hides non-passes identities', async () => {
    const org = await makeOrg(kit.fx, { slug: 'lister', name: 'Lister' });
    for (const [id, purpose] of [
      ['slot-a', 'passes'],
      ['slot-b', 'device_test'],
    ] as const) {
      await credential(id);
      await run(
        kit.env.DB,
        `INSERT INTO signing_identities
           (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id, purpose, is_default, created_at)
         VALUES (?, ?, ?, ?, 'TEAM123456', 'db', ?, ?, 0, 1)`,
        [id, org.id, id, `pass.test.${id}`, `cred-${id}`, purpose],
      );
    }
    const page = await listOrgIdentities(kit.ctx, { limit: 50, orgId: org.id });
    expect(page.items.map((i) => i.id)).toEqual(['slot-a']);
  });
});
