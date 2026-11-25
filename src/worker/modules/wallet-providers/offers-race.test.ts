import { describe, expect, it } from 'vitest';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, batch, first, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import {
  credentialRefKeysetCommitment,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { issueWalletOffer, listWalletOffers, redeemSamsungOffer } from './offers.ts';
import { captureOfferContext, offerPassSnapshot } from './offers-eligibility.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { type WalletOfferFence, walletOfferSnapshotCurrent } from './repo-offers.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';

/** Model a separately audited keyset change without relaxing the production guards. */
async function replaceTestKeyset(db: D1Database, commitment: string | null): Promise<void> {
  const names = [
    'credential_ref_keyset_insert_guard',
    'credential_ref_keyset_no_update',
    'credential_ref_keyset_no_delete',
  ];
  const guards = await all<{ name: string; sql: string }>(
    db,
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)`,
    names,
  );
  if (guards.length !== names.length || guards.some((guard) => !guard.sql))
    throw new Error('Missing keyset guard');
  await batch(db, [
    ...names.map((name) => stmt(db, `DROP TRIGGER ${name}`)),
    stmt(db, 'DELETE FROM credential_ref_keyset WHERE id = 1'),
    ...(commitment === null
      ? []
      : [
          stmt(db, 'INSERT INTO credential_ref_keyset (id, commitment) VALUES (1, ?)', [
            commitment,
          ]),
        ]),
    ...guards.map((guard) => stmt(db, guard.sql)),
  ]);
}

/** Model an operation written before its original keyset was recorded. */
async function replaceTestOperationKeyset(
  db: D1Database,
  operationId: string,
  commitment: string | null,
): Promise<void> {
  const guard = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'wallet_provider_operation_keyset_immutable'",
  );
  if (!guard?.sql) throw new Error('Missing operation keyset guard');
  await batch(db, [
    stmt(db, 'DROP TRIGGER wallet_provider_operation_keyset_immutable'),
    stmt(
      db,
      'UPDATE wallet_provider_instance_operations SET credential_keyset_commitment = ? WHERE id = ?',
      [commitment, operationId],
    ),
    stmt(db, guard.sql),
  ]);
}

/**
 * Exercise the independent SQL fence as if recipient-market proof existed. The proxy does not
 * change the service gates or the D1 triggers that prohibit provider capability issuance.
 */
function marketFenceFixture(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) =>
          target.prepare(
            sql.includes('-- Single SQL form of the provider policy gate')
              ? sql.replace('AND 1 = 0', 'AND 1 = 1')
              : sql,
          );
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('native offer authority fences', () => {
  it('pins the entire KEK ring before asynchronous offer snapshot work', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'configured' });
    const env = { ...f.kit.env };
    const ctx = { ...f.kit.ctx, env };
    const captured = captureOfferContext(ctx);
    const pending = offerPassSnapshot(ctx, f.pass.id);
    env.KEK_V1 = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
    const snapshot = await pending;
    expect(snapshot).not.toBeNull();
    expect(Object.isFrozen(captured.env)).toBe(true);
    expect((captured.env as { KEK_V1?: string }).KEK_V1).toBe(f.kit.env.KEK_V1);
    expect([...(await loadKekRing(captured.env)).keys.keys()]).toEqual([1]);
    expect(await requireCredentialRefKeyset(f.kit.env.DB, captured.env)).toBe(
      f.credentialKeysetCommitment,
    );
    await expect(offerPassSnapshot(ctx, f.pass.id)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
  });

  it('does not deliver even a previously consumed wrapper without recipient-market proof', async () => {
    const f = await setupWalletOfferKit({ google: 'absent' });
    const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id);
    if (!snapshot?.pass.releaseId || !f.samsungRelease)
      throw new Error('Missing approved fixture.');
    const approved = await getApprovedProjection(f.kit.ctx, {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung',
      templateId: f.pass.templateId,
      templateVersion: f.pass.templateVersion,
      appleReleaseId: snapshot.pass.releaseId,
    });
    if (!approved) throw new Error('Missing verified Samsung projection.');
    const now = f.kit.clock.now();
    const operation = await seedHistoricalProviderInstance(f.kit.env.DB, {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung',
      passId: f.pass.id,
      credentialGeneration: snapshot.credentialGeneration,
      credentialKeysetCommitment: f.credentialKeysetCommitment,
      accountId: approved.release.accountId,
      releaseId: approved.release.id,
      now,
      upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'pending' },
    });
    if (!operation) throw new Error('Missing historical instance fixture.');
    // Model only a previously stored hash, never a usable provider or holder bearer token.
    const refHash = 'a'.repeat(64);
    await seedHistoricalOfferRef(f.kit.env.DB, {
      refHash,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt: now,
      deliveredAt: null,
    });
    const offer = {
      refHash,
      instanceId: operation.instanceId,
      version: operation.version,
      now,
      consumed: true,
      deliver: true,
    };
    expect(
      await walletOfferSnapshotCurrent(
        f.kit.env.DB,
        snapshot.pass,
        snapshot.lifecycleGeneration,
        snapshot.credentialGeneration,
        snapshot.rawPassJson,
        'samsung',
        approved.release.id,
        now,
        offer,
      ),
    ).toBe(false);
    expect(
      await first(
        f.kit.env.DB,
        'SELECT delivered_at FROM wallet_provider_offer_refs WHERE ref_hash = ?',
        [refHash],
      ),
    ).toEqual({ delivered_at: null });
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(
      issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'),
    ).rejects.toMatchObject({ status: 403, code: 'WALLET_PROVIDER_DISABLED' });
  });

  it('pins empty and consumed-reference output fences across a missing or rekeyed sentinel', async () => {
    const f = await setupWalletOfferKit({ google: 'absent' });
    const db = f.kit.env.DB;
    const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id);
    if (!snapshot?.pass.releaseId || !f.samsungRelease) throw new Error('Missing approved fixture');
    const approved = await getApprovedProjection(f.kit.ctx, {
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung',
      templateId: f.pass.templateId,
      templateVersion: f.pass.templateVersion,
      appleReleaseId: snapshot.pass.releaseId,
    });
    if (!approved) throw new Error('Missing verified Samsung projection');
    const now = f.kit.clock.now();
    const fenceDb = marketFenceFixture(db);
    const current = (ref?: WalletOfferFence) =>
      walletOfferSnapshotCurrent(
        fenceDb,
        snapshot.pass,
        snapshot.lifecycleGeneration,
        snapshot.credentialGeneration,
        snapshot.rawPassJson,
        'samsung',
        approved.release.id,
        now,
        ref,
      );
    expect(await current()).toBe(true);
    try {
      await replaceTestKeyset(db, null);
      expect(await current()).toBe(false);
    } finally {
      await replaceTestKeyset(db, f.credentialKeysetCommitment);
    }
    const operation = await seedHistoricalProviderInstance(db, {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      orgId: f.pass.orgId,
      mode: f.pass.mode,
      provider: 'samsung',
      passId: f.pass.id,
      credentialGeneration: snapshot.credentialGeneration,
      credentialKeysetCommitment: f.credentialKeysetCommitment,
      accountId: approved.release.accountId,
      releaseId: approved.release.id,
      now,
      upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'succeeded' },
    });
    if (!operation) throw new Error('Missing historical operation');
    const refHash = 'b'.repeat(64);
    await seedHistoricalOfferRef(db, {
      refHash,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt: now,
      deliveredAt: null,
    });
    const offer: WalletOfferFence = {
      refHash,
      instanceId: operation.instanceId,
      version: operation.version,
      now,
      consumed: true,
    };
    expect(await current()).toBe(true);
    expect(await current(offer)).toBe(true);
    await replaceTestOperationKeyset(db, operation.id, null);
    try {
      expect(await current()).toBe(false);
      expect(await current(offer)).toBe(false);
      expect(await current({ ...offer, deliver: true })).toBe(false);
    } finally {
      await replaceTestOperationKeyset(db, operation.id, f.credentialKeysetCommitment);
    }

    const nextEnv = {
      ...f.kit.env,
      KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(23))),
    };
    const nextCtx = { ...f.kit.ctx, env: nextEnv };
    const nextCommitment = await credentialRefKeysetCommitment(nextEnv);
    expect(nextCommitment).not.toBe(f.credentialKeysetCommitment);
    try {
      await replaceTestKeyset(db, null);
      expect(await current()).toBe(false);
      expect(await current({ ...offer, deliver: true })).toBe(false);
      await expect(offerPassSnapshot(f.kit.ctx, f.pass.id)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
      await expect(
        issueWalletOffer(f.kit.ctx, f.pass.downloadToken, 'samsung'),
      ).rejects.toMatchObject({ status: 403, code: 'WALLET_PROVIDER_DISABLED' });
      await expect(redeemSamsungOffer(f.kit.ctx, f.kit.ctx.ids.token(32))).rejects.toMatchObject({
        status: 403,
        code: 'WALLET_PROVIDER_DISABLED',
      });

      await replaceTestKeyset(db, nextCommitment);
      expect(await requireCredentialRefKeyset(db, nextEnv)).toBe(nextCommitment);
      await expect(offerPassSnapshot(f.kit.ctx, f.pass.id)).rejects.toMatchObject({
        code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
      });
      expect(await offerPassSnapshot(nextCtx, f.pass.id)).not.toBeNull();
      expect(await current()).toBe(false);
      expect(await current({ ...offer, deliver: true })).toBe(false);
      // A fresh keyset cannot adopt the retained instance or its wrapper.
      expect(await current()).toBe(false);
      expect(await current({ ...offer, deliver: true })).toBe(false);
      expect(
        await first(db, 'SELECT delivered_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
          refHash,
        ]),
      ).toEqual({ delivered_at: null });
    } finally {
      await replaceTestKeyset(db, f.credentialKeysetCommitment);
    }
  });
});
