import { beforeAll, describe, expect, it, vi } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { credentialRefKeysetCommitment } from '../passes/credential-keyset.ts';
import { startCredentialTransfer } from '../passes/credential-transfer.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { ensureSamsungFetchRef, getSamsungRefreshTarget } from './callbacks-ref.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { configureOn } from './legacy-on-test-fixtures.ts';
import { setWalletProvidersEnabledForTest, whileDisabledForTest } from './provider-policy.ts';
import { darkRows } from './release-test-fixtures.ts';
import { findSamsungFetchSnapshot, samsungFetchSnapshotCurrent } from './repo-callbacks.ts';
import { claimSamsungFetch, claimSamsungReceipt } from './repo-callbacks-events.ts';

// These cases cover historical provider instances, which exist only while a provider is enabled.
beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('Samsung callback authority fences', () => {
  it('does not reuse a captured callback proof after an audited keyset change', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const refHash = await sha256Hex(t.refId);
    const snapshot = await findSamsungFetchSnapshot(db, refHash, t.kit.clock.now(), true);
    if (!snapshot) throw new Error('Missing callback snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const envelope = await encryptSecret(await loadKekRing(t.kit.env), 'receipt', 'test');
    const originalRef = await first(
      db,
      `SELECT id, ref_hash, credential_keyset_commitment, kek_version,
      iv, wrapped_dek, ciphertext FROM wallet_samsung_fetch_refs WHERE id = ?`,
      [t.referenceId],
    );
    const oldKey = t.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const newCommitment = await credentialRefKeysetCommitment({ ...t.kit.env, KEK_V1: newKey });
    expect(newCommitment).not.toBe(t.credentialKeysetCommitment);
    const validToken = await t.token();
    t.kit.env.KEK_V1 = newKey;
    try {
      // A changed environment is rejected even before changing the singleton.
      expect((await t.call({ token: validToken })).status).toBe(503);
      await expect(getSamsungRefreshTarget(t.kit.ctx, snapshot)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });

      // Simulate a separately audited singleton rekey; old durable proofs are still stale.
      await replaceCallbackKeysetForTest(db, newCommitment);
      expect(await findSamsungFetchSnapshot(db, refHash, t.kit.clock.now(), true)).toBeNull();
      // Rows keyed to the old commitment are invisible once the singleton is rekeyed.
      expect(await getSamsungRefreshTarget(t.kit.ctx, snapshot)).toBeNull();
      expect((await t.call({ token: await t.token() })).status).toBe(401);
      const now = t.kit.clock.now();
      const claim = {
        tokenHash: t.kit.ctx.ids.token(32),
        claimId: t.kit.ctx.ids.id(),
        now,
        expiresAt: now + 30_000,
      };
      const receiptClaim = { ...claim, tokenHash: t.kit.ctx.ids.token(32) };
      expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(false);
      expect(
        await claimSamsungReceipt(
          db,
          snapshot,
          receiptClaim,
          {
            id: t.kit.ctx.ids.id(),
            signedAt: now,
            envelope,
            countryHint: 'GB',
            event: null,
            requestId: 'req-1',
            queryBound: false,
          },
          raw,
        ),
      ).toBe(false);
      expect(await samsungFetchSnapshotCurrent(db, snapshot, raw, now)).toBe(false);
      expect(
        await all(
          db,
          'SELECT token_hash FROM wallet_samsung_auth_replays WHERE token_hash IN (?, ?)',
          [claim.tokenHash, receiptClaim.tokenHash],
        ),
      ).toEqual([]);
      expect(
        await all(db, 'SELECT id FROM wallet_samsung_callback_receipts WHERE instance_id = ?', [
          snapshot.instanceId,
        ]),
      ).toEqual([]);
      expect(
        await first(
          db,
          `SELECT id, ref_hash, credential_keyset_commitment, kek_version,
        iv, wrapped_dek, ciphertext FROM wallet_samsung_fetch_refs WHERE id = ?`,
          [t.referenceId],
        ),
      ).toEqual(originalRef);
    } finally {
      t.kit.env.KEK_V1 = oldKey;
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
  });

  it('pins KEKs across decryptions and rechecks the singleton before disclosing a reference', async () => {
    const t = await setupSamsungCallbacks();
    const scope = {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      instanceId: t.operation.instanceId,
      operationVersion: t.operation.version,
    };
    const oldKey = t.kit.env.KEK_V1;
    const newKey = btoa('z'.repeat(32));
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let decryptions = 0;
    const spy = vi
      .spyOn(crypto.subtle, 'decrypt')
      .mockImplementation(async (algorithm, key, data) => {
        const result = await decrypt(algorithm, key, data);
        if (++decryptions === 2) t.kit.env.KEK_V1 = newKey;
        return result;
      });
    try {
      expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toEqual({
        refId: t.refId,
        countryCodes: [],
      });
      expect(decryptions).toBe(2);
    } finally {
      spy.mockRestore();
      t.kit.env.KEK_V1 = oldKey;
    }
    expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toEqual({
      refId: t.refId,
      countryCodes: [],
    });
  });

  it('does not adopt an unproven legacy reference under the current keyset', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const trigger = await first<{ sql: string }>(
      db,
      `SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'wallet_samsung_ref_keyset_immutable'`,
    );
    if (!trigger?.sql) throw new Error('Missing reference immutability guard');
    const setReferenceProof = async (commitment: string | null) => {
      await batch(db, [
        stmt(db, 'DROP TRIGGER wallet_samsung_ref_keyset_immutable'),
        stmt(
          db,
          'UPDATE wallet_samsung_fetch_refs SET credential_keyset_commitment = ? WHERE id = ?',
          [commitment, t.referenceId],
        ),
        stmt(db, trigger.sql),
      ]);
    };
    const scope = {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      instanceId: t.operation.instanceId,
      operationVersion: t.operation.version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    };
    try {
      await setReferenceProof(null);
      expect(
        await findSamsungFetchSnapshot(db, await sha256Hex(t.refId), t.kit.clock.now(), true),
      ).toBeNull();
      expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toBeNull();
      expect((await t.call({ token: await t.token() })).status).toBe(401);
    } finally {
      await setReferenceProof(t.credentialKeysetCommitment);
    }
    expect(await getSamsungRefreshTarget(t.kit.ctx, scope)).toEqual({
      refId: t.refId,
      countryCodes: [],
    });
  });

  it('rejects stale pass revisions, cross-tenant/mode references and rotated accounts', async () => {
    const t = await setupSamsungCallbacks();
    const instance = await first<{ id: string; desired_version: number }>(
      t.kit.env.DB,
      "SELECT id, desired_version FROM wallet_provider_instances WHERE pass_id = ? AND provider = 'samsung'",
      [t.pass.id],
    );
    if (!instance) throw new Error('Missing instance fixture');
    const binding = {
      instanceId: instance.id,
      orgId: t.kit.org.id,
      mode: 'live' as const,
      operationVersion: instance.desired_version,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      expiresAt: t.kit.clock.now() + 60_000,
    };
    const noMint = {
      ...t.kit.ctx,
      ids: {
        ...t.kit.ctx.ids,
        id: () => {
          throw new Error('Unexpected reference allocation');
        },
        token: () => {
          throw new Error('Unexpected reference allocation');
        },
      },
    };
    expect(await whileDisabledForTest(ensureSamsungFetchRef, noMint, binding)).toBeNull();
    await darkRows(t.kit.env.DB);
    await expect(
      run(
        t.kit.env.DB,
        `INSERT INTO wallet_samsung_fetch_refs
      (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at,
       promoted_at, kek_version, iv, wrapped_dek, ciphertext)
      SELECT ?, ?, instance_id, created_at, last_offered_at, initial_expires_at,
        promoted_at, kek_version, iv, wrapped_dek, ciphertext
      FROM wallet_samsung_fetch_refs WHERE id = ?`,
        [t.kit.ctx.ids.id(), '9'.repeat(64), t.referenceId],
      ),
    ).rejects.toThrow('provider reference is unavailable');
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, {
        ...binding,
        orgId: 'other-tenant',
      }),
    ).toBeNull();
    expect(
      await whileDisabledForTest(ensureSamsungFetchRef, t.kit.ctx, { ...binding, mode: 'test' }),
    ).toBeNull();
    await run(t.kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [t.pass.id]);
    // Authentic but stale: answered with no card data, never served.
    const stale = await t.call({ token: await t.token() });
    expect(stale.status).toBe(204);
    expect(await stale.text()).toBe('');

    const rotated = await setupSamsungCallbacks();
    const scope = {
      orgId: rotated.kit.org.id,
      mode: 'live' as const,
      provider: 'samsung' as const,
    };
    const account = await getWalletProviderReadiness(rotated.kit.ctx, scope);
    await configureOn(rotated.kit.ctx, rotated.auth, {
      ...scope,
      expectedRevision: account.revision,
      credentials: rotated.samsung,
    });
    // The instance still operated under the old revision's credential: authentic, answered, no card.
    const answered = await rotated.call({ token: await rotated.token() });
    expect(answered.status).toBe(204);
    expect(await answered.text()).toBe('');
  });

  it('retains refresh across link rotation but fences an old ref during a pending transfer', async () => {
    const t = await setupSamsungCallbacks({ holderEmail: 'first@example.test' });
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    await withoutTrigger(db, 'passes_token_change_moves_link', () =>
      run(db, `UPDATE passes SET download_token = 'h1:' || ? WHERE id = ?`, [
        t.kit.ctx.ids.token(32),
        t.pass.id,
      ]),
    );
    expect((await t.call({ token: await t.token() })).status).toBe(200);
    const generation = await first<{ credential_generation: number }>(
      db,
      'SELECT credential_generation FROM passes WHERE id = ?',
      [t.pass.id],
    );
    expect(generation?.credential_generation).toBe(snapshot.credentialGeneration);
    expect(
      await samsungFetchSnapshotCurrent(
        db,
        {
          ...snapshot,
          credentialGeneration: snapshot.credentialGeneration + 1,
        },
        raw,
        t.kit.clock.now(),
      ),
    ).toBe(false);
    const holder = await getHolderPass(db, t.pass.id, null);
    if (!holder) throw new Error('Missing holder fixture');
    await startCredentialTransfer(
      jobCtxOf(t.kit),
      { type: 'system', id: null },
      t.pass.id,
      { holderEmail: 'second@example.test', ownerUserId: null },
      null,
      { kind: 'tenant-holder', expected: holder },
    );
    const staged = await first<{ credential_generation: number; holder_email: string | null }>(
      db,
      'SELECT credential_generation, holder_email FROM passes WHERE id = ?',
      [t.pass.id],
    );
    expect(staged).toEqual({
      credential_generation: snapshot.credentialGeneration + 1,
      holder_email: 'first@example.test',
    });
    expect(
      await findSamsungFetchSnapshot(db, await sha256Hex(t.refId), t.kit.clock.now(), true),
    ).toBeNull();
    expect(await samsungFetchSnapshotCurrent(db, snapshot, raw, t.kit.clock.now())).toBe(false);
    const now = t.kit.clock.now();
    expect(
      await claimSamsungFetch(
        db,
        snapshot,
        {
          tokenHash: 'F'.repeat(43),
          claimId: t.kit.ctx.ids.id(),
          now,
          expiresAt: now + 30_000,
        },
        raw,
      ),
    ).toBe(false);
    expect((await t.call({ token: await t.token() })).status).toBe(204);
  });

  it('atomically refuses a refresh if materialized pass data changes after capture', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    await run(
      db,
      `UPDATE pass_versions SET pass_json = json_set(pass_json, '$.description', 'changed')
      WHERE pass_id = ? AND version = (SELECT MAX(version) FROM pass_versions WHERE pass_id = ? AND version <= ?)`,
      [snapshot.passId, snapshot.passId, snapshot.passVersion],
    );
    const accepted = await claimSamsungFetch(
      db,
      snapshot,
      {
        tokenHash: 'A'.repeat(43),
        claimId: t.kit.ctx.ids.id(),
        now: t.kit.clock.now(),
        expiresAt: t.kit.clock.now() + 30_000,
      },
      raw,
    );
    expect(accepted).toBe(false);
    const row = await first<{ promoted_at: number | null }>(
      db,
      'SELECT promoted_at FROM wallet_samsung_fetch_refs WHERE id = ?',
      [snapshot.referenceId],
    );
    expect(row?.promoted_at).toBe(snapshot.promotedAt);
    expect(
      await first(db, 'SELECT token_hash FROM wallet_samsung_auth_replays WHERE token_hash = ?', [
        'A'.repeat(43),
      ]),
    ).toBeNull();
  });

  it('does not repeat replay claims or receipts for the same token, even with the same claim id', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const now = t.kit.clock.now();
    const claim = {
      tokenHash: 'B'.repeat(43),
      claimId: t.kit.ctx.ids.id(),
      now,
      expiresAt: now + 30_000,
    };
    expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(true);
    expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(false);
    expect(
      await claimSamsungFetch(db, snapshot, { ...claim, claimId: t.kit.ctx.ids.id() }, raw),
    ).toBe(false);
    const envelope = await encryptSecret(await loadKekRing(t.kit.env), 'untrusted', 'test');
    const postClaim = { ...claim, tokenHash: 'C'.repeat(43), claimId: t.kit.ctx.ids.id() };
    const receipt = {
      id: t.kit.ctx.ids.id(),
      signedAt: now,
      envelope,
      countryHint: 'GB',
      event: null,
      requestId: 'req-1',
      queryBound: false,
    };
    expect(await claimSamsungReceipt(db, snapshot, postClaim, receipt, raw)).toBe(true);
    expect(
      await claimSamsungReceipt(db, snapshot, postClaim, { ...receipt, countryHint: 'US' }, raw),
    ).toBe(false);
    expect(
      await claimSamsungReceipt(
        db,
        snapshot,
        postClaim,
        { ...receipt, id: t.kit.ctx.ids.id(), countryHint: 'US' },
        raw,
      ),
    ).toBe(false);
    expect(
      await claimSamsungReceipt(
        db,
        snapshot,
        { ...postClaim, claimId: t.kit.ctx.ids.id() },
        { ...receipt, id: t.kit.ctx.ids.id(), countryHint: 'US' },
        raw,
      ),
    ).toBe(false);
    const receipts = await all(
      db,
      'SELECT id FROM wallet_samsung_callback_receipts WHERE instance_id = ?',
      [snapshot.instanceId],
    );
    const hints = await all<{ country_code: string }>(
      db,
      'SELECT country_code FROM wallet_samsung_country_hints WHERE ref_id = ?',
      [snapshot.referenceId],
    );
    const instance = await first<{ installation_state: string }>(
      db,
      'SELECT installation_state FROM wallet_provider_instances WHERE id = ?',
      [snapshot.instanceId],
    );
    expect(receipts).toHaveLength(1);
    expect(hints.map((hint) => hint.country_code)).toEqual(['GB']);
    expect(instance?.installation_state).toBe('unknown');
  });
});
