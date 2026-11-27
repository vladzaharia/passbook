import { expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { legacyWalletOfferSnapshotCurrent } from './offers-legacy-test-fixtures.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { type WalletOfferFence, walletOfferSnapshotCurrent } from './repo-offers.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';

/** Only the recipient-market denial is modeled as satisfied; every other fence stays. */
function marketFence(db: D1Database): D1Database {
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

it('reads each CTE once and answers like the previous offer snapshot statement', async () => {
  const f = await setupWalletOfferKit({ google: 'absent' });
  const db = marketFence(f.kit.env.DB);
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
  const seedRef = async (refHash: string, consumedAt: number | null) =>
    seedHistoricalOfferRef(db, {
      refHash,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt,
      deliveredAt: null,
    });
  const [pendingHash, consumedHash, deliverNew, deliverOld] = ['a', 'b', 'd', 'e'].map((c) =>
    c.repeat(64),
  ) as [string, string, string, string];
  await seedRef(pendingHash, null);
  await seedRef(consumedHash, now);
  await seedRef(deliverNew, now);
  await seedRef(deliverOld, now);
  const pending: WalletOfferFence = {
    refHash: pendingHash,
    instanceId: operation.instanceId,
    version: operation.version,
    now,
    consumed: false,
  };
  const consumed: WalletOfferFence = { ...pending, refHash: consumedHash, consumed: true };

  let trueCount = 0;
  const both = async (
    offer?: WalletOfferFence,
    changes: Partial<typeof snapshot> = {},
    releaseId = approved.release.id,
  ) => {
    const value = { ...snapshot, ...changes };
    const args = [
      value.pass,
      value.lifecycleGeneration,
      value.credentialGeneration,
      value.rawPassJson,
      'samsung',
      releaseId,
      now,
      offer,
    ] as const;
    const next = await walletOfferSnapshotCurrent(db, ...args);
    expect(next).toBe(await legacyWalletOfferSnapshotCurrent(db, ...args));
    if (next) trueCount++;
  };
  const matrix = async () => {
    for (const offer of [undefined, pending, consumed]) await both(offer);
    await both({ ...pending, consumed: true });
    await both({ ...pending, refHash: 'c'.repeat(64) });
    await both({ ...pending, instanceId: crypto.randomUUID() });
    await both({ ...pending, version: pending.version + 1 });
    await both({ ...pending, now: now + 300_000 });
    await both({ ...consumed, deliver: true, refHash: 'c'.repeat(64) });
    await both(pending, { lifecycleGeneration: snapshot.lifecycleGeneration + 1 });
    await both(pending, { credentialGeneration: snapshot.credentialGeneration + 1 });
    await both(pending, { rawPassJson: '{}' });
    for (const pass of [
      { ...snapshot.pass, version: snapshot.pass.version + 1 },
      { ...snapshot.pass, orgId: crypto.randomUUID() },
      { ...snapshot.pass, templateVersion: snapshot.pass.templateVersion + 1 },
      { ...snapshot.pass, releaseId: crypto.randomUUID() },
      { ...snapshot.pass, downloadToken: 'stale-token' },
      { ...snapshot.pass, holderEmail: 'different@example.test' },
    ])
      await both(pending, { pass });
    await both(pending, {}, crypto.randomUUID());
  };

  await matrix();
  expect(trueCount).toBeGreaterThan(2);
  // Delivery: the guarded UPDATE of each statement flips only its own consumed ref.
  const deliveredAt = (hash: string) =>
    first(db, 'SELECT delivered_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [hash]);
  const args = [
    snapshot.pass,
    snapshot.lifecycleGeneration,
    snapshot.credentialGeneration,
    snapshot.rawPassJson,
    'samsung',
    approved.release.id,
    now,
  ] as const;
  const fence = (refHash: string) => ({ ...consumed, refHash, deliver: true });
  expect(await walletOfferSnapshotCurrent(db, ...args, fence(deliverNew))).toBe(true);
  expect(await legacyWalletOfferSnapshotCurrent(db, ...args, fence(deliverOld))).toBe(true);
  expect(await deliveredAt(deliverNew)).toEqual(await deliveredAt(deliverOld));
  expect(await deliveredAt(deliverNew)).toEqual({ delivered_at: now });
  expect(await walletOfferSnapshotCurrent(db, ...args, fence(deliverNew))).toBe(false);
  expect(await legacyWalletOfferSnapshotCurrent(db, ...args, fence(deliverOld))).toBe(false);

  for (const sql of [
    "UPDATE wallet_provider_instance_operations SET state = 'failed' WHERE id = ?",
    "UPDATE wallet_provider_instance_operations SET state = 'succeeded' WHERE id = ?",
  ]) {
    await run(db, sql, [operation.id]);
    await matrix();
  }
  await run(
    db,
    `INSERT INTO wallet_provider_pass_authority (pass_id, generation) VALUES (?, 1)
     ON CONFLICT(pass_id) DO UPDATE SET generation = generation + 1`,
    [f.pass.id],
  );
  await matrix();
  await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?', [
    now,
    operation.instanceId,
  ]);
  await matrix();
});
