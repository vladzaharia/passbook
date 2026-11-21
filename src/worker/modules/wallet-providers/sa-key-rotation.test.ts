import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFixtureIdentity } from '../../../passkit/testing/fixture-identity.ts';
import { all, first, run as sql } from '../../platform/db.ts';
import { saveOrgCredential } from './credential-service.ts';
import { readGoogleSecret, saveSystemCredential } from './credential-system-save.ts';
import { setManagedDeps } from './google-managed-deps.ts';
import { type ManagedKit, managedKit } from './google-managed-kit-fixtures.ts';
import { keyNameOf } from './google-managed-test-fixtures.ts';
import { findCredential } from './repo-credentials.ts';
import { resumeRun } from './repo-google-managed.ts';
import { dailyGoogleKeys, runKeyInventory } from './sa-key-inventory.ts';
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
        secret: {
          ...(await readGoogleSecret(m.ctx, m.platform.id)).credentials,
          privateKeyPem: (await createFixtureIdentity()).privateKey,
          issuerId: '6200',
        },
        origin: { provenance: 'own', signerRef: null },
      },
      'issuer_provision',
    );
    const _oldPem = await pem(m.platform.id);
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
    expect(await pem(own.id)).not.toBe(newPem);
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

/** Runs a rotation to its cooldown: the new key is in and verified, orgs follow, the old key waits. */
async function toCooldown() {
  const { runId } = await startKeyRotation(m.ctx, { credentialId: m.platform.id, createdBy: null });
  await runKeyRotation(m.ctx, runId);
  expect(await runRow(runId)).toMatchObject({ state: 'waiting', waiting_for: 'old_key_cooldown' });
  return runId;
}
/** The cooldown is over: resume the run. */
async function afterCooldown(runId: string) {
  await sql(
    db(),
    "UPDATE identity_runs SET external_ref = json_set(external_ref, '$.deleteAfter', 1) WHERE id = ?",
    [runId],
  );
  expect(await resumeRun(db(), runId, Date.now())).toBe(true);
  await runKeyRotation(m.ctx, runId);
}
const keyStates = () =>
  all<{ key_name: string; state: string }>(
    db(),
    'SELECT key_name, state FROM wallet_sa_keys ORDER BY created_at, key_name',
  );

describe('rotation safety', () => {
  beforeEach(async () => {
    await sql(db(), 'DELETE FROM wallet_sa_keys', []);
    await sql(
      db(),
      "UPDATE identity_runs SET state = 'cancelled' WHERE provider = 'google' AND state IN ('queued', 'running', 'waiting')",
      [],
    );
  });

  it('a rollback whose delete fails is finished on retry, and the restored key is never retired', async () => {
    const before = await pem(m.platform.id);
    const { runId } = await startKeyRotation(m.ctx, {
      credentialId: m.platform.id,
      createdBy: null,
    });
    m.stub.failTokenAfterCreate = 3;
    m.stub.failDeleteTimes = 1;
    await expect(runKeyRotation(m.ctx, runId)).rejects.toThrow();
    // The old key is current again, and the run is marked before anything was restored.
    expect(await pem(m.platform.id)).toBe(before);
    expect(
      (
        await first<{ s: string }>(
          db(),
          "SELECT json_extract(external_ref, '$.stage') AS s FROM identity_runs WHERE id = ?",
          [runId],
        )
      )?.s,
    ).toBe('rolled_back');
    expect(m.stub.keys).toHaveLength(2);
    // The retry finishes the rollback: no verify, no fan-out, no retire.
    await runKeyRotation(m.ctx, runId);
    expect(await runRow(runId)).toMatchObject({
      state: 'failed',
      error_code: 'WALLET_KEY_VERIFY_FAILED',
    });
    expect(m.stub.keys).toEqual([keyNameOf(1)]);
    expect(await pem(m.platform.id)).toBe(before);
    expect((await keyStates()).map((k) => k.state)).toEqual(['active', 'retired']);
  });

  it('refuses to delete the old key when the credential left the new version', async () => {
    const runId = await toCooldown();
    // An admin re-saves the platform credential with the old key during the cooldown.
    const cred = await findCredential(db(), m.platform.id, null);
    const oldSecret = (
      await readGoogleSecret(
        m.ctx,
        m.platform.id,
        (
          await first<{ v: string }>(
            db(),
            "SELECT json_extract(external_ref, '$.prevVersionId') AS v FROM identity_runs WHERE id = ?",
            [runId],
          )
        )?.v,
      )
    ).credentials;
    await saveSystemCredential(
      m.ctx,
      { orgId: null, mode: 'live', current: cred, secret: oldSecret },
      'sa_key',
    );
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({
      state: 'failed',
      error_code: 'WALLET_KEY_NOT_RETIRING',
    });
    expect(m.stub.keys).toHaveLength(2);
  });

  it('never deletes a key that is active again', async () => {
    const runId = await toCooldown();
    const old = (await keyStates()).find((k) => k.state === 'retiring');
    await sql(db(), "UPDATE wallet_sa_keys SET state = 'active' WHERE key_name = ?", [
      old?.key_name ?? '',
    ]);
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({
      state: 'failed',
      error_code: 'WALLET_KEY_NOT_RETIRING',
    });
    expect(m.stub.keys).toContain(old?.key_name);
  });

  it('waits while an issuer run is working, then deletes the old key', async () => {
    const runId = await toCooldown();
    const org = await m.org('Busy');
    await sql(
      db(),
      "INSERT INTO identity_runs (id, org_id, provider, kind, target_type, target_id, state, lease_until, created_at, updated_at) VALUES ('busy-run', ?, 'google', 'provision', 'wallet_credential', 'google:live:busy', 'running', ?, 1, 1)",
      [org.id, Date.now() + 600_000],
    );
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({ state: 'waiting', waiting_for: 'old_key_held' });
    expect(m.stub.keys).toHaveLength(2);
    await sql(db(), "UPDATE identity_runs SET state = 'succeeded' WHERE id = 'busy-run'", []);
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({ state: 'succeeded' });
    expect(m.stub.keys).toHaveLength(1);
    expect((await keyStates()).map((k) => k.state)).toEqual(['retired', 'active']);
  });

  it('two deliveries of one run create one key', async () => {
    const { runId } = await startKeyRotation(m.ctx, {
      credentialId: m.platform.id,
      createdBy: null,
    });
    const settled = await Promise.allSettled([
      runKeyRotation(m.ctx, runId),
      runKeyRotation(m.ctx, runId),
    ]);
    // The loser is told to retry later, not to give up.
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(m.stub.created).toHaveLength(1);
    expect(await runRow(runId)).toMatchObject({
      state: 'waiting',
      waiting_for: 'old_key_cooldown',
    });
  });

  it("leaves an org's own key alone: a member save ends PassBook's hold on the credential", async () => {
    const managed = await signedOrg('Own Key', '6400');
    const { auth } = await m.k.member(managed.org_id ?? '', 'live');
    await saveOrgCredential(m.ctx, auth, managed.org_id ?? '', {
      provider: 'google',
      expectedRevision: managed.revision,
      credentials: m.k.google('6400'),
    });
    expect((await findCredential(db(), managed.id, managed.org_id))?.signer_ref).toBeNull();
    const own = await pem(managed.id);
    await toCooldown();
    expect(await pem(managed.id)).toBe(own);
  });

  it('removes a key an earlier attempt made and never used, and records the new key before it is used', async () => {
    await sql(
      db(),
      "INSERT INTO wallet_sa_keys (key_name, credential_id, origin, state, created_at) VALUES (?, ?, 'created', 'pending', 1)",
      [keyNameOf(5), m.platform.id],
    );
    m.stub.keys = [keyNameOf(1), keyNameOf(5)];
    await toCooldown();
    expect(m.stub.keys).not.toContain(keyNameOf(5));
    expect((await keyStates()).find((k) => k.key_name === keyNameOf(5))?.state).toBe('retired');
    expect((await keyStates()).filter((k) => k.state === 'active')).toHaveLength(1);
  });

  it('moves credentials of every mode that hold the key (a test-mode platform credential and its orgs), then deletes the old key', async () => {
    const live = (await readGoogleSecret(m.ctx, m.platform.id)).credentials;
    const testPlatform = await saveSystemCredential(
      m.ctx,
      {
        orgId: null,
        mode: 'test',
        current: null,
        secret: { ...live, issuerId: '1000000000000002' },
      },
      'sa_key',
    );
    const testOrg = await m.org('Test Mode Org');
    const testOrgCred = await saveSystemCredential(
      m.ctx,
      {
        orgId: testOrg.id,
        mode: 'test',
        current: null,
        secret: { ...live, issuerId: '6500' },
        origin: { provenance: 'managed', signerRef: testPlatform.id },
      },
      'issuer_provision',
    );
    const runId = await toCooldown();
    const newPem = m.stub.created[0];
    expect(await pem(testPlatform.id)).toBe(newPem);
    expect(await pem(testOrgCred.id)).toBe(newPem);
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({ state: 'succeeded' });
    expect(await pem(testOrgCred.id)).toBe(newPem);
    expect(m.stub.keys).toHaveLength(1);
  });

  it('a parked old_key_held run is resumed by the daily pass once the holder is gone', async () => {
    const runId = await toCooldown();
    const org = await m.org('Busy Again');
    await sql(
      db(),
      "INSERT INTO identity_runs (id, org_id, provider, kind, target_type, target_id, state, lease_until, created_at, updated_at) VALUES ('busy-run-2', ?, 'google', 'provision', 'wallet_credential', 'google:live:busy2', 'running', ?, 1, 1)",
      [org.id, Date.now() + 600_000],
    );
    await afterCooldown(runId);
    expect(await runRow(runId)).toMatchObject({ state: 'waiting', waiting_for: 'old_key_held' });
    await sql(db(), "UPDATE identity_runs SET state = 'succeeded' WHERE id = 'busy-run-2'", []);
    await sql(
      db(),
      "UPDATE identity_runs SET external_ref = json_set(external_ref, '$.deleteAfter', 1) WHERE id = ?",
      [runId],
    );
    m.sent.length = 0;
    await dailyGoogleKeys(m.ctx);
    expect(m.sent).toContainEqual({ kind: 'wallet.google_key_rotate', runId });
    await runKeyRotation(m.ctx, runId);
    expect(await runRow(runId)).toMatchObject({ state: 'succeeded' });
    expect(m.stub.keys).toHaveLength(1);
  });

  it('a crashed job: the retry is told to wait, then the planner resumes the run once the lease ran out', async () => {
    const { runId } = await startKeyRotation(m.ctx, {
      credentialId: m.platform.id,
      createdBy: null,
    });
    // The first job died holding the run.
    await sql(db(), "UPDATE identity_runs SET state = 'running', lease_until = ? WHERE id = ?", [
      Date.now() + 300_000,
      runId,
    ]);
    await expect(runKeyRotation(m.ctx, runId)).rejects.toMatchObject({ code: 'WALLET_RUN_BUSY' });
    await dailyGoogleKeys(m.ctx);
    expect((await runRow(runId))?.state).toBe('running');
    await sql(db(), 'UPDATE identity_runs SET lease_until = ? WHERE id = ?', [
      Date.now() - 1000,
      runId,
    ]);
    m.sent.length = 0;
    await dailyGoogleKeys(m.ctx);
    expect(m.sent).toContainEqual({ kind: 'wallet.google_key_rotate', runId });
    expect((await runRow(runId))?.state).toBe('queued');
    await runKeyRotation(m.ctx, runId);
    expect(await runRow(runId)).toMatchObject({
      state: 'waiting',
      waiting_for: 'old_key_cooldown',
    });
  });

  it('a rollback restores credentials made while the new key was current, then deletes it', async () => {
    const before = await pem(m.platform.id);
    let during = '';
    m.stub.onToken = async () => {
      const made = await signedOrg('During Verify', '6600');
      during = made.id;
    };
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
    expect(during).not.toBe('');
    expect(await pem(during)).toBe(before);
    expect(m.stub.keys).toEqual([keyNameOf(1)]);
  });

  it('the daily run deletes a pending key no rotation holds', async () => {
    await sql(
      db(),
      "INSERT INTO wallet_sa_keys (key_name, credential_id, origin, state, created_at) VALUES (?, ?, 'created', 'pending', 1), (?, ?, 'adopted', 'active', 1)",
      [keyNameOf(6), m.platform.id, keyNameOf(1), m.platform.id],
    );
    m.stub.keys = [keyNameOf(1), keyNameOf(6)];
    await dailyGoogleKeys(m.ctx);
    expect(m.stub.keys).toEqual([keyNameOf(1)]);
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
