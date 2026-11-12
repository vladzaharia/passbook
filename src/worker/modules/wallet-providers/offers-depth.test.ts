import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { offerPassSnapshot } from './offers-eligibility.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { getApprovedProjection } from './projection-service.ts';
import { type WalletOfferFence, walletOfferSnapshotCurrent } from './repo-offers.ts';
import {
  seedHistoricalOfferRef,
  seedHistoricalProviderInstance,
} from './runtime-historical-fixtures.ts';

type CapturedStatement = { sql: string; params: unknown[] };

function captureStatements(db: D1Database, seen: CapturedStatement[]): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, key) {
              if (key === 'bind')
                return (...params: unknown[]) => {
                  seen.push({ sql, params });
                  return prepared.bind(...params);
                };
              const value = Reflect.get(prepared, key, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Model recipient-market evidence only for the read fences, without changing D1's capability guards. */
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

describe('offer snapshot SQL depth', () => {
  it('compiles every atomic snapshot shape and retains the complete offer fences', async () => {
    const f = await setupWalletOfferKit({ google: 'absent' });
    const db = f.kit.env.DB;
    const snapshot = await offerPassSnapshot(f.kit.ctx, f.pass.id, f.credentialKeysetCommitment);
    if (!snapshot?.pass.releaseId || !f.samsungRelease) throw new Error('Missing approved fixture');
    const approved = await getApprovedProjection(
      f.kit.ctx,
      {
        orgId: f.pass.orgId,
        mode: f.pass.mode,
        provider: 'samsung',
        templateId: f.pass.templateId,
        templateVersion: f.pass.templateVersion,
        appleReleaseId: snapshot.pass.releaseId,
      },
      { credentialKeysetCommitment: snapshot.credentialKeysetCommitment },
    );
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
      credentialKeysetCommitment: snapshot.credentialKeysetCommitment,
      accountId: approved.release.accountId,
      releaseId: approved.release.id,
      now,
      upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'succeeded' },
    });
    if (!operation) throw new Error('Missing historical operation');
    const pendingHash = 'a'.repeat(64);
    const consumedHash = 'b'.repeat(64);
    for (const [refHash, consumedAt] of [
      [pendingHash, null],
      [consumedHash, now],
    ] as const) {
      await seedHistoricalOfferRef(db, {
        refHash,
        instanceId: operation.instanceId,
        operationVersion: operation.version,
        createdAt: now,
        expiresAt: now + 300_000,
        consumedAt,
        deliveredAt: null,
      });
    }
    const pending: WalletOfferFence = {
      refHash: pendingHash,
      instanceId: operation.instanceId,
      version: operation.version,
      now,
      consumed: false,
    };
    const consumed: WalletOfferFence = { ...pending, refHash: consumedHash, consumed: true };
    const current = (
      database: D1Database,
      offer?: WalletOfferFence,
      changes: Partial<typeof snapshot> = {},
      releaseId = approved.release.id,
    ) => {
      const value = { ...snapshot, ...changes };
      return walletOfferSnapshotCurrent(
        database,
        value.pass,
        value.lifecycleGeneration,
        value.credentialGeneration,
        value.credentialKeysetCommitment,
        value.rawPassJson,
        'samsung',
        releaseId,
        now,
        offer,
      );
    };

    const seen: CapturedStatement[] = [];
    const captured = captureStatements(db, seen);
    expect(await current(captured)).toBe(false);
    expect(await current(captured, pending)).toBe(false);
    expect(await current(captured, consumed)).toBe(false);
    expect(await current(captured, { ...consumed, deliver: true })).toBe(false);
    expect(seen.map(({ params }) => params.length)).toEqual([25, 30, 30, 32]);
    for (const { sql, params } of seen) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all();
      const bytecode = await db
        .prepare(`EXPLAIN ${sql}`)
        .bind(...params)
        .all();
      expect(plan.results.length).toBeGreaterThan(0);
      expect(bytecode.results.length).toBeGreaterThan(0);
    }
    expect(
      await first(db, 'SELECT delivered_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
        consumedHash,
      ]),
    ).toEqual({ delivered_at: null });

    // Only the recipient-market denial is modeled as satisfied; all other fences and D1 guards remain.
    const market = marketFenceFixture(db);
    expect(await current(market)).toBe(true);
    expect(await current(market, pending)).toBe(true);
    expect(await current(market, consumed)).toBe(true);
    expect(await current(market, { ...pending, consumed: true })).toBe(false);
    expect(await current(market, { ...pending, refHash: 'c'.repeat(64) })).toBe(false);
    expect(await current(market, { ...pending, instanceId: crypto.randomUUID() })).toBe(false);
    expect(await current(market, { ...pending, version: pending.version + 1 })).toBe(false);
    expect(await current(market, { ...pending, now: now + 300_000 })).toBe(false);
    expect(
      await current(market, { ...consumed, version: consumed.version + 1, deliver: true }),
    ).toBe(false);
    expect(
      await current(market, pending, { lifecycleGeneration: snapshot.lifecycleGeneration + 1 }),
    ).toBe(false);
    expect(
      await current(market, pending, { credentialGeneration: snapshot.credentialGeneration + 1 }),
    ).toBe(false);
    expect(await current(market, pending, { credentialKeysetCommitment: 'd'.repeat(64) })).toBe(
      false,
    );
    expect(await current(market, pending, { rawPassJson: '{}' })).toBe(false);
    for (const pass of [
      { ...snapshot.pass, version: snapshot.pass.version + 1 },
      { ...snapshot.pass, revision: snapshot.pass.revision + 1 },
      { ...snapshot.pass, orgId: crypto.randomUUID() },
      { ...snapshot.pass, templateVersion: snapshot.pass.templateVersion + 1 },
      { ...snapshot.pass, releaseId: crypto.randomUUID() },
      { ...snapshot.pass, linkGeneration: snapshot.pass.linkGeneration + 1 },
      { ...snapshot.pass, downloadToken: 'stale-token' },
      { ...snapshot.pass, ownerUserId: crypto.randomUUID() },
      { ...snapshot.pass, holderEmail: 'different@example.test' },
      { ...snapshot.pass, objectSha256: 'e'.repeat(64) },
    ]) {
      expect(await current(market, pending, { pass })).toBe(false);
    }
    expect(await current(market, pending, {}, crypto.randomUUID())).toBe(false);

    await run(db, "UPDATE wallet_provider_instance_operations SET state = 'failed' WHERE id = ?", [
      operation.id,
    ]);
    expect(await current(market)).toBe(true);
    expect(await current(market, pending)).toBe(false);
    expect(await current(market, consumed)).toBe(false);
    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'succeeded' WHERE id = ?",
      [operation.id],
    );

    await run(
      db,
      `INSERT INTO wallet_provider_pass_authority (pass_id, generation) VALUES (?, 1)
       ON CONFLICT(pass_id) DO UPDATE SET generation = generation + 1`,
      [f.pass.id],
    );
    expect(await current(market)).toBe(true);
    expect(await current(market, pending)).toBe(false);
    expect(await current(market, consumed)).toBe(false);

    const refreshedHash = 'c'.repeat(64);
    await seedHistoricalOfferRef(db, {
      refHash: refreshedHash,
      instanceId: operation.instanceId,
      operationVersion: operation.version,
      createdAt: now,
      expiresAt: now + 300_000,
      consumedAt: null,
      deliveredAt: null,
    });
    const refreshed = { ...pending, refHash: refreshedHash };
    expect(await current(market, refreshed)).toBe(true);
    await run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?', [
      now,
      operation.instanceId,
    ]);
    expect(await current(market)).toBe(true);
    expect(await current(market, refreshed)).toBe(false);
  }, 120_000);
});
