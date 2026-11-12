import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { consumeOffer, insertOffer, readOffer } from './repo-instance-offers.ts';
import { seedHistoricalOfferRef } from './runtime-historical-fixtures.ts';

async function withoutTrigger(
  db: D1Database,
  name:
    | 'credential_ref_keyset_no_update'
    | 'wallet_provider_operation_keyset_immutable'
    | 'wallet_provider_instance_keyset_immutable'
    | 'wallet_provider_generation_offer_insert'
    | 'wallet_provider_generation_offer_consume',
  action: () => Promise<void>,
): Promise<void> {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    [name],
  );
  if (!trigger?.sql) throw new Error(`Missing trigger ${name}`);
  await run(db, `DROP TRIGGER ${name}`);
  try {
    await action();
  } finally {
    await run(db, trigger.sql);
  }
}

describe('wallet offer reference keyset authority', () => {
  it('binds insertion, reads and consumption to the captured instance and operation commitment', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const now = t.kit.clock.now();
    const commitment = await requireCredentialRefKeyset(db, t.kit.env);
    const other = commitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    const hash = await sha256Hex(t.kit.ctx.ids.token(32));
    const input = {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      provider: t.operation.provider,
      instanceId: t.operation.instanceId,
      version: t.operation.version,
      operationId: t.operation.id,
      credentialKeysetCommitment: commitment,
      hash: await sha256Hex(t.kit.ctx.ids.token(32)),
      authority: { kind: 'download' as const, token: t.pass.downloadToken },
      now,
      expiresAt: now + 60_000,
    };
    const wrongInput = { ...input, credentialKeysetCommitment: other };
    await seedHistoricalOfferRef(db, {
      refHash: hash,
      instanceId: t.operation.instanceId,
      operationVersion: t.operation.version,
      createdAt: now,
      expiresAt: now + 60_000,
      consumedAt: null,
      deliveredAt: null,
    });

    expect(await readOffer(db, hash, now, commitment)).toMatchObject({
      instanceId: t.operation.instanceId,
      credentialKeysetCommitment: commitment,
    });
    expect(await readOffer(db, hash, now, other)).toBeNull();
    expect(await consumeOffer(db, hash, now, other)).toBeNull();
    expect(await insertOffer(db, wrongInput)).toBe(false);
    // The independent issuance/consumption gates remain closed even for a valid keyset.
    await expect(insertOffer(db, input)).rejects.toThrow('provider offer is unavailable');
    await expect(consumeOffer(db, hash, now, commitment)).rejects.toThrow(
      'provider offer is unavailable',
    );

    // Isolate the repository CAS while leaving the real provider gates in place outside the fixture.
    await withoutTrigger(db, 'wallet_provider_generation_offer_insert', async () => {
      expect(await insertOffer(db, wrongInput)).toBe(false);
      expect(await insertOffer(db, input)).toBe(true);
    });
    expect(await readOffer(db, input.hash, now, commitment)).toMatchObject({
      credentialKeysetCommitment: commitment,
    });

    await withoutTrigger(db, 'credential_ref_keyset_no_update', async () => {
      await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [other]);
      try {
        for (const captured of [commitment, other]) {
          expect(await readOffer(db, hash, now, captured)).toBeNull();
          expect(await consumeOffer(db, hash, now, captured)).toBeNull();
          expect(
            await insertOffer(db, {
              ...input,
              hash: await sha256Hex(t.kit.ctx.ids.token(32)),
              credentialKeysetCommitment: captured,
            }),
          ).toBe(false);
        }
        expect(
          await first(db, 'SELECT consumed_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
            hash,
          ]),
        ).toEqual({ consumed_at: null });
      } finally {
        await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [commitment]);
      }
    });

    for (const [trigger, table, id] of [
      [
        'wallet_provider_operation_keyset_immutable',
        'wallet_provider_instance_operations',
        t.operation.id,
      ],
      [
        'wallet_provider_instance_keyset_immutable',
        'wallet_provider_instances',
        t.operation.instanceId,
      ],
    ] as const) {
      await withoutTrigger(db, trigger, async () => {
        try {
          for (const value of [null, other]) {
            await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
              value,
              id,
            ]);
            expect(await readOffer(db, hash, now, commitment)).toBeNull();
            expect(await consumeOffer(db, hash, now, commitment)).toBeNull();
            expect(
              await insertOffer(db, { ...input, hash: await sha256Hex(t.kit.ctx.ids.token(32)) }),
            ).toBe(false);
          }
        } finally {
          await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
            commitment,
            id,
          ]);
        }
      });
    }
    const captured: { sql: string; params: unknown[] }[] = [];
    const captureDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(prepared, member) {
                if (member === 'bind')
                  return (...params: unknown[]) => {
                    captured.push({ sql, params });
                    return prepared.bind(...params);
                  };
                const value = Reflect.get(prepared, member, prepared);
                return typeof value === 'function' ? value.bind(prepared) : value;
              },
            });
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await withoutTrigger(db, 'wallet_provider_generation_offer_consume', async () => {
      expect(await consumeOffer(db, hash, now, other)).toBeNull();
      expect(
        await first(db, 'SELECT consumed_at FROM wallet_provider_offer_refs WHERE ref_hash = ?', [
          hash,
        ]),
      ).toEqual({ consumed_at: null });
      expect(await consumeOffer(captureDb, hash, now, commitment)).toMatchObject({
        credentialKeysetCommitment: commitment,
      });
      expect(await consumeOffer(db, hash, now, commitment)).toBeNull();
    });
    const updates = captured.filter(({ sql }) =>
      /UPDATE wallet_provider_offer_refs AS ref/.test(sql),
    );
    expect(updates).toHaveLength(1);
    const update = updates[0]!;
    expect(update.params).toEqual([hash, now, commitment, commitment, now, now]);
    await db
      .prepare(`EXPLAIN ${update.sql}`)
      .bind(...update.params)
      .all();
  }, 90_000);
});
