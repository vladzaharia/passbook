import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, first, run as sql } from '../../platform/db.ts';
import { readGoogleSecret, saveSystemCredential } from './credential-system-save.ts';
import { setManagedDeps } from './google-managed-deps.ts';
import { type ManagedKit, managedKit } from './google-managed-kit-fixtures.ts';
import { keyNameOf } from './google-managed-test-fixtures.ts';
import { findCredential } from './repo-credentials.ts';
import { resumeRun } from './repo-google-managed.ts';
import { runKeyInventory } from './sa-key-inventory.ts';
import { runKeyRotation, startKeyRotation } from './sa-key-rotation.ts';

let m: ManagedKit;
beforeAll(async () => {
  m = await managedKit();
}, 30_000);
afterAll(() => setManagedDeps());
beforeEach(() => {
  m.stub.keys = [keyNameOf(1)];
  m.stub.created = [];
  m.stub.failTokenAfterCreate = 0;
  m.stub.failTokenTimes = 0;
});

const db = () => m.k.env.DB;
const runRow = (id: string) =>
  first<{ state: string; waiting_for: string | null; error_code: string | null }>(
    db(),
    'SELECT state, waiting_for, error_code FROM identity_runs WHERE id = ?',
    [id],
  );
const pem = async (id: string) => (await readGoogleSecret(m.ctx, id)).credentials.privateKeyPem;

/** An org credential that signs with the platform key (managed or shared). */
async function signedOrg(name: string, issuerId: string) {
  const org = await m.org(name);
  const secret = {
    ...(await readGoogleSecret(m.ctx, m.platform.id)).credentials,
    issuerId,
  };
  return saveSystemCredential(
    m.ctx,
    {
      orgId: org.id,
      mode: 'live',
      current: null,
      secret,
      origin: { provenance: 'managed', signerRef: m.platform.id },
    },
    'issuer_provision',
  );
}

describe('service-account key rotation', () => {
  it('overlaps: new key in, orgs follow, the old key goes a day later; ids and enrolment sources stay', async () => {
    const managed = await signedOrg('Rot Managed', '6100');
    const loner = await m.org('Rot Own');
    const own = await saveSystemCredential(
      m.ctx,
      {
        orgId: loner.id,
        mode: 'live',
        current: null,
        secret: { ...(await readGoogleSecret(m.ctx, m.platform.id)).credentials, issuerId: '6200' },
        origin: { provenance: 'own', signerRef: null },
      },
      'issuer_provision',
    );
    const oldPem = await pem(m.platform.id);
    const started = await startKeyRotation(m.ctx, { credentialId: m.platform.id, createdBy: null });
    expect(started.created).toBe(true);
    // One open rotation per credential.
    expect(
      (await startKeyRotation(m.ctx, { credentialId: m.platform.id, createdBy: null })).runId,
    ).toBe(started.runId);
    await runKeyRotation(m.ctx, started.runId);

    expect(await runRow(started.runId)).toMatchObject({
      state: 'waiting',
      waiting_for: 'old_key_cooldown',
    });
    // Both keys exist during the overlap; the platform and the signed org use the new one.
    expect(m.stub.keys).toHaveLength(2);
    expect(m.stub.created).toHaveLength(1);
    const newPem = m.stub.created[0];
    expect(await pem(m.platform.id)).toBe(newPem);
    expect(await pem(managed.id)).toBe(newPem);
    expect((await readGoogleSecret(m.ctx, managed.id)).credentials.issuerId).toBe('6100');
    // The credential keeps its id; only its revision moved (an enrolment names the id).
    expect((await findCredential(db(), managed.id, managed.org_id))?.revision).toBe(
      managed.revision + 1,
    );
    // An org with its own key is left alone.
    expect(await pem(own.id)).toBe(oldPem);
    const platform = await findCredential(db(), m.platform.id, null);
    expect(platform?.next_rotation_at).toBeGreaterThan(Date.now() + 89 * 86_400_000);
    // The uploaded key was adopted, the new one recorded.
    expect(
      (
        await all<{ origin: string }>(db(), 'SELECT origin FROM wallet_sa_keys ORDER BY created_at')
      ).map((r) => r.origin),
    ).toEqual(['adopted', 'created']);

    // Before the day is out the job leaves the old key alone.
    await sql(db(), 'UPDATE identity_runs SET state = ? WHERE id = ?', ['queued', started.runId]);
    await runKeyRotation(m.ctx, started.runId);
    expect(m.stub.keys).toHaveLength(2);
    // A day later it is deleted and the run is done.
    await sql(
      db(),
      "UPDATE identity_runs SET state = 'waiting', waiting_for = 'old_key_cooldown', external_ref = json_set(external_ref, '$.deleteAfter', 1) WHERE id = ?",
      [started.runId],
    );
    expect(await resumeRun(db(), started.runId, Date.now())).toBe(true);
    await runKeyRotation(m.ctx, started.runId);
    expect(await runRow(started.runId)).toMatchObject({ state: 'succeeded' });
    expect(m.stub.keys).toEqual([expect.stringContaining('/keys/')]);
    expect(m.stub.keys).not.toContain(keyNameOf(1));
    expect(
      (
        await first<{ n: number }>(
          db(),
          'SELECT COUNT(*) AS n FROM wallet_sa_keys WHERE deleted_at IS NOT NULL',
        )
      )?.n,
    ).toBe(1);
    // Free the slot for the next case.
    await sql(db(), 'DELETE FROM wallet_sa_keys', []);
  });

  it('rolls back when the new key fails verification: old key kept, new one deleted, orgs untouched', async () => {
    const managed = await signedOrg('Rot Fail', '6300');
    m.stub.keys = [keyNameOf(1)];
    const before = await pem(m.platform.id);
    const revision = (await findCredential(db(), m.platform.id, null))?.next_rotation_at ?? null;
    m.stub.failTokenAfterCreate = 3;
    const { runId } = await startKeyRotation(m.ctx, {
      credentialId: m.platform.id,
      createdBy: null,
    });
    await runKeyRotation(m.ctx, runId);

    expect(await runRow(runId)).toMatchObject({
      state: 'failed',
      error_code: 'WALLET_KEY_VERIFY_FAILED',
    });
    // The platform credential signs with the old key again, as a new version.
    expect(await pem(m.platform.id)).toBe(before);
    expect(await pem(managed.id)).toBe(before);
    expect(m.stub.keys).toEqual([keyNameOf(1)]);
    expect((await findCredential(db(), m.platform.id, null))?.next_rotation_at).toBe(revision);
    // The next attempt starts clean.
    const retry = await startKeyRotation(m.ctx, { credentialId: m.platform.id, createdBy: null });
    expect(retry.created).toBe(true);
    await sql(db(), "UPDATE identity_runs SET state = 'cancelled' WHERE id = ?", [retry.runId]);
  });

  it('refuses to rotate while keys it did not create exist', async () => {
    m.stub.keys = [keyNameOf(1), keyNameOf(2)];
    const { runId } = await startKeyRotation(m.ctx, {
      credentialId: m.platform.id,
      createdBy: null,
    });
    await runKeyRotation(m.ctx, runId);
    expect(await runRow(runId)).toMatchObject({
      state: 'failed',
      error_code: 'WALLET_KEY_UNKNOWN',
    });
    expect(m.stub.created).toHaveLength(0);
    expect(m.stub.keys).toHaveLength(2);
  });
});

describe('key inventory', () => {
  const alerts = () =>
    all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE action = 'wallet.key_unknown'",
    );

  it('adopts a single uploaded key, with no alert', async () => {
    await sql(db(), 'DELETE FROM wallet_sa_keys', []);
    const before = (await alerts()).length;
    m.stub.keys = [keyNameOf(1)];
    await runKeyInventory(m.ctx);
    expect((await alerts()).length).toBe(before);
    expect(
      (
        await first<{ origin: string }>(
          db(),
          'SELECT origin FROM wallet_sa_keys WHERE deleted_at IS NULL',
        )
      )?.origin,
    ).toBe('adopted');
  });

  it('alerts on a key it did not create, and on more than two keys; deletes nothing', async () => {
    const before = (await alerts()).length;
    m.stub.keys = [keyNameOf(1), keyNameOf(77)];
    await runKeyInventory(m.ctx);
    expect((await alerts()).length).toBe(before + 1);
    // Once a day is enough.
    await runKeyInventory(m.ctx);
    expect((await alerts()).length).toBe(before + 1);
    expect(m.stub.keys).toEqual([keyNameOf(1), keyNameOf(77)]);

    // Three keys, all recorded: still too many.
    await sql(
      db(),
      "DELETE FROM settings WHERE scope = 'system' AND key LIKE 'wallet_sa_inventory.%'",
      [],
    );
    for (const id of [77, 78])
      await sql(
        db(),
        "INSERT OR IGNORE INTO wallet_sa_keys (key_name, credential_id, origin, created_at) VALUES (?, ?, 'created', 1)",
        [keyNameOf(id), m.platform.id],
      );
    m.stub.keys = [keyNameOf(1), keyNameOf(77), keyNameOf(78)];
    await runKeyInventory(m.ctx);
    expect((await alerts()).length).toBe(before + 2);
  });
});
