import { describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { claimWalletOperation, newWalletClaimHandle } from './instance.ts';
import {
  beginSamsungSyncTarget,
  ensureSamsungSyncTargets,
  finishSamsungSyncTarget,
  listSamsungSyncTargets,
  samsungSyncCountryHints,
} from './repo-sync-targets.ts';

async function withoutTrigger(
  db: D1Database,
  name:
    | 'credential_ref_keyset_no_update'
    | 'wallet_samsung_ref_keyset_immutable'
    | 'wallet_provider_operation_keyset_immutable'
    | 'wallet_provider_instance_keyset_immutable',
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

describe('Samsung sync target keyset authority', () => {
  it('pins hints, claims, outcomes and settlement to the original operation and reference keyset', async () => {
    const t = await setupSamsungCallbacks();
    const db = t.kit.env.DB;
    const now = t.kit.clock.now();
    const commitment = await requireCredentialRefKeyset(db, t.kit.env);
    const other = commitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    const instance = {
      instanceId: t.operation.instanceId,
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      credentialKeysetCommitment: commitment,
    };
    const claim = {
      ...instance,
      provider: 'samsung' as const,
      version: t.operation.version,
      claimHandle: newWalletClaimHandle(),
      now,
    };
    const wrongClaim = { ...claim, credentialKeysetCommitment: other };
    for (const country of ['GB', 'US'])
      await run(
        db,
        'INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at) VALUES (?, ?, ?)',
        [t.referenceId, country, now],
      );

    expect(await samsungSyncCountryHints(t.kit.ctx, instance)).toEqual(['GB', 'US']);
    expect(
      await samsungSyncCountryHints(t.kit.ctx, { ...instance, credentialKeysetCommitment: other }),
    ).toEqual([]);
    expect(await claimWalletOperation(db, claim)).toBe('claimed');
    await withoutTrigger(db, 'wallet_samsung_ref_keyset_immutable', async () => {
      try {
        for (const value of [null, other]) {
          await run(
            db,
            'UPDATE wallet_samsung_fetch_refs SET credential_keyset_commitment = ? WHERE id = ?',
            [value, t.referenceId],
          );
          expect(await samsungSyncCountryHints(t.kit.ctx, instance)).toEqual([]);
          await ensureSamsungSyncTargets(t.kit.ctx, claim);
          expect(await listSamsungSyncTargets(t.kit.ctx, claim)).toEqual([]);
        }
      } finally {
        await run(
          db,
          'UPDATE wallet_samsung_fetch_refs SET credential_keyset_commitment = ? WHERE id = ?',
          [commitment, t.referenceId],
        );
      }
    });
    await ensureSamsungSyncTargets(t.kit.ctx, wrongClaim);
    expect(await listSamsungSyncTargets(t.kit.ctx, claim)).toEqual([]);
    await ensureSamsungSyncTargets(t.kit.ctx, claim);
    expect(
      (await listSamsungSyncTargets(t.kit.ctx, claim)).map((target) => target.countryCode),
    ).toEqual(['GB', 'US']);
    expect(await beginSamsungSyncTarget(t.kit.ctx, wrongClaim, 'GB')).toBeNull();
    expect(await beginSamsungSyncTarget(t.kit.ctx, claim, 'GB')).toBe(1);
    expect(await finishSamsungSyncTarget(t.kit.ctx, wrongClaim, 'GB', { kind: 'success' })).toBe(
      false,
    );
    await run(
      db,
      'INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at) VALUES (?, ?, ?)',
      [t.referenceId, 'FR', now],
    );

    await withoutTrigger(db, 'credential_ref_keyset_no_update', async () => {
      await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [other]);
      try {
        for (const candidate of [claim, wrongClaim]) {
          await ensureSamsungSyncTargets(t.kit.ctx, candidate);
          expect(await listSamsungSyncTargets(t.kit.ctx, candidate)).toEqual([]);
          expect(await beginSamsungSyncTarget(t.kit.ctx, candidate, 'US')).toBeNull();
          expect(
            await finishSamsungSyncTarget(t.kit.ctx, candidate, 'GB', { kind: 'success' }),
          ).toBe(false);
          expect(await samsungSyncCountryHints(t.kit.ctx, candidate)).toEqual([]);
        }
        expect(
          await first(
            db,
            'SELECT COUNT(*) AS count FROM wallet_provider_sync_targets WHERE operation_id = ?',
            [t.operation.id],
          ),
        ).toEqual({ count: 2 });
      } finally {
        await run(db, 'UPDATE credential_ref_keyset SET commitment = ? WHERE id = 1', [commitment]);
      }
    });
    await ensureSamsungSyncTargets(t.kit.ctx, claim);
    expect(
      (await listSamsungSyncTargets(t.kit.ctx, claim)).map((target) => target.countryCode),
    ).toEqual(['FR', 'GB', 'US']);
    await run(
      db,
      'INSERT INTO wallet_samsung_country_hints (ref_id, country_code, received_at) VALUES (?, ?, ?)',
      [t.referenceId, 'DE', now],
    );

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
            expect(await samsungSyncCountryHints(t.kit.ctx, instance)).toEqual([]);
            await ensureSamsungSyncTargets(t.kit.ctx, claim);
            expect(
              await first(
                db,
                'SELECT COUNT(*) AS count FROM wallet_provider_sync_targets WHERE operation_id = ?',
                [t.operation.id],
              ),
            ).toEqual({ count: 3 });
            expect(await listSamsungSyncTargets(t.kit.ctx, claim)).toEqual([]);
            expect(await beginSamsungSyncTarget(t.kit.ctx, claim, 'US')).toBeNull();
            expect(await finishSamsungSyncTarget(t.kit.ctx, claim, 'GB', { kind: 'success' })).toBe(
              false,
            );
          }
        } finally {
          await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
            commitment,
            id,
          ]);
        }
      });
    }
    await ensureSamsungSyncTargets(t.kit.ctx, claim);
    expect(
      (await listSamsungSyncTargets(t.kit.ctx, claim)).map((target) => target.countryCode),
    ).toEqual(['DE', 'FR', 'GB', 'US']);
    expect(await finishSamsungSyncTarget(t.kit.ctx, claim, 'GB', { kind: 'success' })).toBe(true);
    expect(await beginSamsungSyncTarget(t.kit.ctx, claim, 'US')).toBe(1);
  }, 90_000);
});
