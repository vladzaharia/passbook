import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { insertDesiredOperation } from './repo-instance.ts';
import {
  claimOperation,
  finishOperation,
  markUncertain,
  settleClaim,
} from './repo-instance-claims.ts';

type CapturedStatement = { sql: string; params: unknown[] };

function interceptDatabase(
  db: D1Database,
  seen: CapturedStatement[],
  beforeBatch?: () => Promise<void>,
): D1Database {
  let injected = false;
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
      if (property === 'batch' && beforeBatch)
        return async (statements: D1PreparedStatement[]) => {
          if (!injected) {
            injected = true;
            await beforeBatch();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function claimFixture(db: D1Database) {
  const fixture = await setupSamsungCallbacks({ reference: false, db });
  const operation = fixture.operation;
  const claim = {
    orgId: operation.orgId,
    mode: operation.mode,
    provider: operation.provider,
    instanceId: operation.instanceId,
    version: operation.version,
    credentialKeysetCommitment: operation.credentialKeysetCommitment,
    hash: 'a'.repeat(64),
    now: fixture.kit.clock.now(),
  };
  return { ...fixture, claim };
}

async function outcome(env: object, orgId: string) {
  const id = crypto.randomUUID();
  return {
    id,
    eventHash: 'c'.repeat(64),
    payloadHash: 'd'.repeat(64),
    envelope: await encryptSecret(
      await loadKekRing(env),
      new Uint8Array([1, 2]),
      credentialAad(id, orgId, 'wallet.provider.outcome'),
    ),
  };
}

describe('wallet operation claim SQL and atomicity', () => {
  const makeEnv = installKeysetTestEnv();

  it('explains real claim UPDATEs and preserves settlement, replacement, CAS and rollback', async () => {
    const db = (await makeEnv()).DB;
    const fixture = await claimFixture(db);
    const { claim, operation } = fixture;
    const seen: CapturedStatement[] = [];
    const captured = interceptDatabase(db, seen);

    expect(await claimOperation(db, claim)).toBe('claimed');
    expect(await markUncertain(db, claim)).toBe(true);
    await run(
      db,
      `INSERT INTO wallet_provider_sync_targets
        (operation_id, country_code, state, attempts, updated_at) VALUES (?, 'GB', 'inflight', 1, ?)`,
      [operation.id, claim.now],
    );
    const settledAt = claim.now + 1;
    await run(
      db,
      `CREATE TRIGGER test_claim_settlement_rollback BEFORE UPDATE ON wallet_provider_sync_targets
       BEGIN SELECT RAISE(ABORT, 'forced target failure'); END`,
    );
    try {
      await expect(settleClaim(captured, { ...claim, now: settledAt })).rejects.toThrow(
        'forced target failure',
      );
    } finally {
      await run(db, 'DROP TRIGGER test_claim_settlement_rollback');
    }
    expect(
      await first(
        db,
        'SELECT state, last_result_at FROM wallet_provider_instance_operations WHERE id = ?',
        [operation.id],
      ),
    ).toEqual({ state: 'uncertain', last_result_at: null });
    expect(await settleClaim(captured, { ...claim, now: settledAt })).toBe(true);
    expect(
      await first(
        db,
        `SELECT state, attempts, next_attempt_at, reason_code, last_result_at, completed_at
         FROM wallet_provider_instance_operations WHERE id = ?`,
        [operation.id],
      ),
    ).toEqual({
      state: 'retry',
      attempts: 1,
      next_attempt_at: settledAt + 1000,
      reason_code: 'timeout',
      last_result_at: settledAt,
      completed_at: null,
    });
    expect(
      await first(
        db,
        `SELECT state, next_attempt_at, reason_code, updated_at FROM wallet_provider_sync_targets
         WHERE operation_id = ? AND country_code = 'GB'`,
        [operation.id],
      ),
    ).toEqual({
      state: 'retry',
      next_attempt_at: settledAt + 1000,
      reason_code: 'timeout',
      updated_at: settledAt,
    });

    // A replay cannot move a target even if it is independently still in flight.
    await run(
      db,
      "UPDATE wallet_provider_sync_targets SET state = 'inflight', next_attempt_at = NULL WHERE operation_id = ?",
      [operation.id],
    );
    expect(await settleClaim(captured, { ...claim, now: settledAt })).toBe(false);
    expect(
      await first(db, 'SELECT state FROM wallet_provider_sync_targets WHERE operation_id = ?', [
        operation.id,
      ]),
    ).toEqual({ state: 'inflight' });
    await run(
      db,
      "UPDATE wallet_provider_sync_targets SET state = 'retry' WHERE operation_id = ?",
      [operation.id],
    );

    const replacement = { ...claim, hash: 'b'.repeat(64), now: settledAt + 1000 };
    expect(await claimOperation(db, replacement)).toBe('claimed');
    // A settlement intended for the previous uncertain claim cannot settle a new claimed attempt.
    expect(await settleClaim(captured, replacement)).toBe(false);
    const raw = await outcome(fixture.kit.env, operation.orgId);
    const finish = {
      ...replacement,
      operationId: operation.id,
      attempt: 2,
      result: {
        kind: 'failure' as const,
        reason: 'rate_limited' as const,
        retryable: true,
        retryAfterMs: 5000,
        httpStatus: 429,
      },
      raw,
    };
    expect(await finishOperation(captured, { ...finish, hash: claim.hash })).toBeNull();
    expect(await finishOperation(captured, { ...finish, attempt: 1 })).toBeNull();
    expect(
      await finishOperation(captured, { ...finish, operationId: crypto.randomUUID() }),
    ).toBeNull();
    await run(
      db,
      "UPDATE wallet_provider_sync_targets SET state = 'inflight' WHERE operation_id = ?",
      [operation.id],
    );
    expect(await finishOperation(captured, finish)).toBeNull();
    await run(
      db,
      "UPDATE wallet_provider_sync_targets SET state = 'retry' WHERE operation_id = ?",
      [operation.id],
    );
    expect(
      await first(
        db,
        'SELECT state, attempts, claim_hash FROM wallet_provider_instance_operations WHERE id = ?',
        [operation.id],
      ),
    ).toEqual({ state: 'claimed', attempts: 2, claim_hash: replacement.hash });
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS count FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
        [operation.id],
      ),
    ).toEqual({ count: 0 });

    // A failure in the provenance insert must roll the preceding operation UPDATE back.
    await expect(
      finishOperation(captured, { ...finish, raw: { ...raw, eventHash: 'invalid' } }),
    ).rejects.toThrow();
    expect(
      await first(
        db,
        'SELECT state, attempts, claim_hash FROM wallet_provider_instance_operations WHERE id = ?',
        [operation.id],
      ),
    ).toEqual({ state: 'claimed', attempts: 2, claim_hash: replacement.hash });
    expect(await finishOperation(captured, finish)).toBe('retry');
    expect(await finishOperation(captured, finish)).toBeNull();
    expect(
      await first(
        db,
        `SELECT state, next_attempt_at, reason_code, http_status, last_result_at, completed_at
         FROM wallet_provider_instance_operations WHERE id = ?`,
        [operation.id],
      ),
    ).toEqual({
      state: 'retry',
      next_attempt_at: replacement.now + 5000,
      reason_code: 'rate_limited',
      http_status: 429,
      last_result_at: replacement.now,
      completed_at: null,
    });
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS count FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
        [operation.id],
      ),
    ).toEqual({ count: 1 });

    const third = { ...claim, hash: 'e'.repeat(64), now: replacement.now + 5000 };
    expect(await claimOperation(db, third)).toBe('claimed');
    expect(
      await finishOperation(captured, {
        ...third,
        operationId: operation.id,
        attempt: 3,
        result: { kind: 'not_issued' },
      }),
    ).toBeNull(); // The Samsung not-issued proof is only valid for revoke operations.
    expect(
      await finishOperation(captured, {
        ...third,
        operationId: operation.id,
        attempt: 3,
        result: { kind: 'success' },
      }),
    ).toBe('succeeded');

    // stmt() parenthesizes AND chains; compare the fences without that grouping.
    const flat = (sql: string) => sql.replace(/[()\s]+/g, ' ');
    const updates = seen.filter(({ sql }) => sql.includes('WITH scoped_operation AS MATERIALIZED'));
    const settlement = updates.find(({ sql }) => flat(sql).includes("op.state = 'uncertain'"));
    const finalization = updates.find(({ sql }) =>
      flat(sql).includes('op.claim_hash = ? AND op.state'),
    );
    const notIssued = updates.find(({ sql }) => flat(sql).includes("AND op.kind = 'revoke'"));
    const revoke = seen.find(({ sql }) =>
      sql.includes("UPDATE wallet_provider_instances AS i SET lifecycle = 'revoked'"),
    );
    if (!settlement || !finalization || !notIssued || !revoke)
      throw new Error('Claim UPDATE was not captured');
    expect(
      [settlement, finalization, notIssued, revoke].map(({ params }) => params.length),
    ).toEqual([20, 32, 33, 14]);
    for (const { sql } of [settlement, finalization, notIssued]) {
      expect(sql.match(/FROM current_operation proven/g)).toHaveLength(1);
    }
    for (const { sql, params } of [settlement, finalization, notIssued, revoke]) {
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
  }, 120_000);

  it('rechecks keyset and desired operation when settling the transaction', async () => {
    const db = (await makeEnv()).DB;
    const { claim, operation } = await claimFixture(db);
    expect(await claimOperation(db, claim)).toBe('claimed');
    expect(await markUncertain(db, claim)).toBe(true);
    await run(
      db,
      `INSERT INTO wallet_provider_sync_targets
        (operation_id, country_code, state, attempts, updated_at) VALUES (?, 'GB', 'uncertain', 1, ?)`,
      [operation.id, claim.now],
    );
    const other =
      claim.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const switchedKeyset = interceptDatabase(db, [], () => replaceCallbackKeysetForTest(db, other));
    try {
      expect(await settleClaim(switchedKeyset, { ...claim, now: claim.now + 1 })).toBe(false);
      expect(
        await first(
          db,
          'SELECT state, last_result_at FROM wallet_provider_instance_operations WHERE id = ?',
          [operation.id],
        ),
      ).toEqual({ state: 'uncertain', last_result_at: null });
      expect(
        await first(db, 'SELECT state FROM wallet_provider_sync_targets WHERE operation_id = ?', [
          operation.id,
        ]),
      ).toEqual({ state: 'uncertain' });
    } finally {
      await replaceCallbackKeysetForTest(db, claim.credentialKeysetCommitment);
    }

    const next = {
      ...operation,
      operationId: crypto.randomUUID(),
      requestHash: await sha256Hex(crypto.randomUUID()),
      expectedVersion: operation.version,
      kind: 'upsert' as const,
      now: claim.now + 1,
    };
    const switchedOperation = interceptDatabase(db, [], () => insertDesiredOperation(db, next));
    expect(await settleClaim(switchedOperation, { ...claim, now: next.now })).toBe(true);
    expect(
      await first(
        db,
        'SELECT state, reason_code, last_result_at, completed_at FROM wallet_provider_instance_operations WHERE id = ?',
        [operation.id],
      ),
    ).toEqual({
      state: 'superseded',
      reason_code: 'timeout',
      last_result_at: next.now,
      completed_at: next.now,
    });
    expect(
      await first(
        db,
        'SELECT state, next_attempt_at FROM wallet_provider_sync_targets WHERE operation_id = ?',
        [operation.id],
      ),
    ).toEqual({ state: 'failed', next_attempt_at: null });
    expect(
      await first(db, 'SELECT state FROM wallet_provider_instance_operations WHERE id = ?', [
        next.operationId,
      ]),
    ).toEqual({ state: 'pending' });
  }, 120_000);

  it('rechecks keyset and pass authority before finalization and never persists stale output', async () => {
    const db = (await makeEnv()).DB;
    const fixture = await claimFixture(db);
    const { claim, operation } = fixture;
    expect(await claimOperation(db, claim)).toBe('claimed');
    const finish = {
      ...claim,
      operationId: operation.id,
      attempt: 1,
      result: { kind: 'success' as const, httpStatus: 200 },
      raw: await outcome(fixture.kit.env, operation.orgId),
    };
    const other =
      claim.credentialKeysetCommitment === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    const switchedKeyset = interceptDatabase(db, [], () => replaceCallbackKeysetForTest(db, other));
    try {
      expect(await finishOperation(switchedKeyset, finish)).toBeNull();
    } finally {
      await replaceCallbackKeysetForTest(db, claim.credentialKeysetCommitment);
    }
    expect(
      await first(
        db,
        'SELECT state, claim_hash FROM wallet_provider_instance_operations WHERE id = ?',
        [operation.id],
      ),
    ).toEqual({ state: 'claimed', claim_hash: claim.hash });

    const stalePass = interceptDatabase(db, [], async () => {
      await run(db, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [operation.passId]);
    });
    expect(await finishOperation(stalePass, finish)).toBe('superseded');
    expect(await finishOperation(db, finish)).toBeNull();
    expect(
      await first(
        db,
        `SELECT state, reason_code, http_status, next_attempt_at, last_result_at, completed_at
         FROM wallet_provider_instance_operations WHERE id = ?`,
        [operation.id],
      ),
    ).toEqual({
      state: 'superseded',
      reason_code: null,
      http_status: null,
      next_attempt_at: null,
      last_result_at: claim.now,
      completed_at: claim.now,
    });
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS count FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
        [operation.id],
      ),
    ).toEqual({ count: 0 });
    expect(
      await first(db, 'SELECT lifecycle FROM wallet_provider_instances WHERE id = ?', [
        operation.instanceId,
      ]),
    ).toEqual({ lifecycle: 'active' });
  }, 120_000);
});
