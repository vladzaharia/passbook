import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { findSamsungFetchSnapshot } from './repo-callbacks.ts';
import { claimSamsungFetch, claimSamsungReceipt } from './repo-callbacks-events.ts';
import {
  claimOperation,
  expireClaims,
  finishOperation,
  markUncertain,
  settleClaim,
} from './repo-instance-claims.ts';
import { deferWalletSyncOperation } from './repo-sync-queue.ts';

// Epoch triggers on these tables add writes to D1's change count; results must not depend on it.
const NOISY_TABLES = [
  'wallet_provider_instances',
  'wallet_provider_instance_operations',
  'wallet_provider_accounts',
];

async function addNoOpTriggers(db: D1Database) {
  await run(db, 'CREATE TABLE trigger_noise (n INTEGER)');
  for (const table of NOISY_TABLES)
    await run(
      db,
      `CREATE TRIGGER noise_${table} AFTER UPDATE ON ${table}
       BEGIN INSERT INTO trigger_noise (n) VALUES (1); END`,
    );
}

describe('row counts, not trigger counts', () => {
  const makeEnv = installKeysetTestEnv();

  it.each([false, true])(
    'operation claim, settle, finish and defer flows (no-op triggers: %s)',
    async (noisy) => {
      const db = (await makeEnv()).DB;
      const { kit, operation } = await setupSamsungCallbacks({ reference: false, db });
      if (noisy) await addNoOpTriggers(db);
      const now = kit.clock.now();
      const claim = {
        orgId: operation.orgId,
        mode: operation.mode,
        provider: operation.provider,
        instanceId: operation.instanceId,
        version: operation.version,
        credentialKeysetCommitment: operation.credentialKeysetCommitment,
        hash: 'a'.repeat(64),
        now,
      };
      const results: unknown[] = [];

      results.push(await claimOperation(db, claim));
      results.push(await claimOperation(db, claim));
      results.push(await markUncertain(db, { ...claim, hash: 'f'.repeat(64) }));
      results.push(await markUncertain(db, claim));
      results.push(await expireClaims(db, now + 600_000, 10, claim.credentialKeysetCommitment));
      await run(
        db,
        `INSERT INTO wallet_provider_sync_targets
        (operation_id, country_code, state, attempts, updated_at) VALUES (?, 'GB', 'inflight', 1, ?)`,
        [operation.id, now],
      );
      results.push(await settleClaim(db, { ...claim, now: now + 1 }));
      results.push(await settleClaim(db, { ...claim, now: now + 1 }));
      results.push(
        await first(db, 'SELECT state FROM wallet_provider_sync_targets WHERE operation_id = ?', [
          operation.id,
        ]),
      );
      results.push(await deferWalletSyncOperation(db, claim, now + 2, 5000));

      const second = { ...claim, hash: 'b'.repeat(64), now: now + 10_000 };
      results.push(await claimOperation(db, second));
      const outcomeId = crypto.randomUUID();
      const finish = {
        ...second,
        operationId: operation.id,
        attempt: 2,
        result: { kind: 'success' as const },
        raw: {
          id: outcomeId,
          eventHash: 'c'.repeat(64),
          payloadHash: 'd'.repeat(64),
          envelope: await encryptSecret(
            await loadKekRing(kit.env),
            new Uint8Array([1, 2]),
            credentialAad(outcomeId, operation.orgId, 'wallet.provider.outcome'),
          ),
        },
      };
      results.push(await finishOperation(db, { ...finish, hash: 'e'.repeat(64) }));
      results.push(await finishOperation(db, finish));
      results.push(await finishOperation(db, finish));
      results.push(
        await first(
          db,
          'SELECT COUNT(*) AS count FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
          [operation.id],
        ),
      );

      expect(results).toEqual([
        'claimed',
        'already_claimed',
        false,
        true,
        0,
        true,
        false,
        { state: 'retry' },
        true,
        'claimed',
        null,
        'succeeded',
        null,
        { count: 1 },
      ]);
    },
  );

  it.each([false, true])(
    'Samsung replay and receipt admission (no-op triggers: %s)',
    async (noisy) => {
      const db = (await makeEnv()).DB;
      const t = await setupSamsungCallbacks({ db });
      if (noisy) await addNoOpTriggers(db);
      const snapshot = await findSamsungFetchSnapshot(
        db,
        await sha256Hex(t.refId),
        t.kit.clock.now(),
        t.credentialKeysetCommitment,
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
      const results: unknown[] = [];
      results.push(await claimSamsungFetch(db, snapshot, claim, raw));
      results.push(await claimSamsungFetch(db, snapshot, claim, raw));
      results.push(await claimSamsungReceipt(db, snapshot, postClaim, receipt, raw));
      results.push(
        await claimSamsungReceipt(db, snapshot, postClaim, { ...receipt, countryHint: 'US' }, raw),
      );
      results.push(
        await first(
          db,
          'SELECT COUNT(*) AS count FROM wallet_samsung_callback_receipts WHERE instance_id = ?',
          [snapshot.instanceId],
        ),
      );
      results.push(
        await first(
          db,
          'SELECT COUNT(*) AS count FROM wallet_samsung_country_hints WHERE ref_id = ?',
          [snapshot.referenceId],
        ),
      );
      expect(results).toEqual([true, false, true, false, { count: 1 }, { count: 1 }]);
    },
  );

  it('refuses a receipt for a token a GET already claimed, even with the same claim id', async () => {
    const db = (await makeEnv()).DB;
    const t = await setupSamsungCallbacks({ db });
    const snapshot = await findSamsungFetchSnapshot(
      db,
      await sha256Hex(t.refId),
      t.kit.clock.now(),
      t.credentialKeysetCommitment,
    );
    if (!snapshot) throw new Error('Missing fetch snapshot');
    const raw = await passJsonAtVersion(db, snapshot.passId, snapshot.passVersion);
    if (!raw) throw new Error('Missing materialized pass');
    const now = t.kit.clock.now();
    const claim = {
      tokenHash: 'D'.repeat(43),
      claimId: t.kit.ctx.ids.id(),
      now,
      expiresAt: now + 30_000,
    };
    const receipt = {
      id: t.kit.ctx.ids.id(),
      signedAt: now,
      envelope: await encryptSecret(await loadKekRing(t.kit.env), 'untrusted', 'test'),
      countryHint: 'GB',
      event: null,
      requestId: 'req-1',
      queryBound: false,
    };
    expect(await claimSamsungFetch(db, snapshot, claim, raw)).toBe(true);
    expect(await claimSamsungReceipt(db, snapshot, claim, receipt, raw)).toBe(false);
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS count FROM wallet_samsung_callback_receipts WHERE instance_id = ?',
        [snapshot.instanceId],
      ),
    ).toEqual({ count: 0 });
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS count FROM wallet_samsung_country_hints WHERE ref_id = ?',
        [snapshot.referenceId],
      ),
    ).toEqual({ count: 0 });
  });
});
