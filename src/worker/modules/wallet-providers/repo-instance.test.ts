import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import {
  ackDirtyInstance,
  deferDirtyInstance,
  getInstanceById,
  getInstanceByPass,
  getOperation,
  getOperationByRequest,
  insertDesiredOperation,
  insertInstance,
  listDirtyInstances,
  listDueOperations,
  readPassSnapshot,
} from './repo-instance.ts';
import {
  claimOperation,
  finishOperation,
  markUncertain,
  operationFresh,
} from './repo-instance-claims.ts';
import { insertOutcome } from './repo-instance-outcomes.ts';
import { deferWalletSyncOperation } from './repo-sync-queue.ts';
import { seedHistoricalProviderInstance } from './runtime-historical-fixtures.ts';

const makeEnv = installKeysetTestEnv();

async function withoutTrigger(
  db: D1Database,
  name:
    | 'wallet_provider_generation_insert_guard'
    | 'wallet_provider_instance_keyset_immutable'
    | 'wallet_provider_operation_keyset_immutable',
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

async function withStoredCommitment(
  db: D1Database,
  table: 'wallet_provider_instances' | 'wallet_provider_instance_operations',
  id: string,
  original: string,
  value: string | null,
  action: () => Promise<void>,
): Promise<void> {
  const trigger =
    table === 'wallet_provider_instances'
      ? 'wallet_provider_instance_keyset_immutable'
      : 'wallet_provider_operation_keyset_immutable';
  await withoutTrigger(db, trigger, async () => {
    await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [value, id]);
    try {
      await action();
    } finally {
      await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
        original,
        id,
      ]);
    }
  });
}

describe('wallet provider instance repository keyset authority', () => {
  it('persists the original commitment on both initial rows without opening issuance or offer gates', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const pass = await t.kit.pass();
    const snapshot = await readPassSnapshot(db, {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      passId: pass.id,
      credentialKeysetCommitment: t.credentialKeysetCommitment,
    });
    if (!snapshot?.issuingReleaseId) throw new Error('Missing new pass snapshot');
    const input = {
      ...t.operation,
      instanceId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      requestHash: await sha256Hex(crypto.randomUUID()),
      passId: pass.id,
      passVersion: snapshot.passVersion,
      passRevision: snapshot.passRevision,
      lifecycleGeneration: snapshot.lifecycleGeneration,
      passCredentialGeneration: snapshot.credentialGeneration,
      issuingReleaseId: snapshot.issuingReleaseId,
      now: t.kit.clock.now(),
    };
    const other =
      input.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    await insertInstance(db, { ...input, credentialKeysetCommitment: other });
    await insertInstance(db, { ...input, credentialKeysetCommitment: 'invalid' });
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [input.instanceId]),
    ).toBeNull();
    await expect(insertInstance(db, input)).rejects.toThrow('provider issuance is unavailable');

    // Isolate repository persistence without changing the real, independently closed provider gates.
    await withoutTrigger(db, 'wallet_provider_generation_insert_guard', async () => {
      await expect(
        insertInstance(db, input, {
          hash: await sha256Hex(crypto.randomUUID()),
          expiresAt: input.now + 60_000,
          authority: { kind: 'download', token: pass.downloadToken },
        }),
      ).rejects.toThrow('provider offer is unavailable');
      expect(
        await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [
          input.instanceId,
        ]),
      ).toBeNull();
      await insertInstance(db, input);
      expect(await getInstanceById(db, input)).toMatchObject({
        id: input.instanceId,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
      });
      expect(await getOperation(db, { ...input, version: 1 })).toMatchObject({
        id: input.operationId,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
      });
      expect(
        await first(
          db,
          `SELECT i.credential_keyset_commitment AS instance_commitment,
        op.credential_keyset_commitment AS operation_commitment FROM wallet_provider_instances i
        JOIN wallet_provider_instance_operations op ON op.instance_id = i.id WHERE i.id = ?`,
          [input.instanceId],
        ),
      ).toEqual({
        instance_commitment: input.credentialKeysetCommitment,
        operation_commitment: input.credentialKeysetCommitment,
      });
    });
  }, 120_000);

  it('returns only the captured keyset on reads and fences dirty work across replacement or deletion', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const now = t.kit.clock.now();
    const ref = {
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      instanceId: op.instanceId,
      version: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    };
    const other =
      op.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    const stored = await first<{ request_hash: string }>(
      db,
      'SELECT request_hash FROM wallet_provider_instance_operations WHERE id = ?',
      [op.id],
    );
    if (!stored) throw new Error('Missing provider operation');
    const request = { ...ref, requestHash: stored.request_hash };
    await run(
      db,
      `INSERT INTO wallet_provider_instance_dirty (instance_id, generation, next_attempt_at)
      VALUES (?, 1, 0) ON CONFLICT(instance_id) DO UPDATE SET generation = 1, next_attempt_at = 0`,
      [op.instanceId],
    );
    const dirty = { ...ref, generation: 1 };

    expect(await getInstanceByPass(db, { ...ref, passId: op.passId })).toMatchObject({
      id: op.instanceId,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
    expect(await getInstanceById(db, ref)).toMatchObject({
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
    expect(await getOperation(db, ref)).toMatchObject({
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
    expect(await getOperationByRequest(db, request)).toMatchObject({
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
    expect(await readPassSnapshot(db, { ...ref, passId: op.passId })).toMatchObject({
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
    expect(
      await listDueOperations(db, now, 100, null, op.credentialKeysetCommitment),
    ).toContainEqual(
      expect.objectContaining({
        id: op.id,
        credentialKeysetCommitment: op.credentialKeysetCommitment,
      }),
    );
    expect(
      await listDirtyInstances(db, now, 100, null, op.credentialKeysetCommitment),
    ).toContainEqual(
      expect.objectContaining({
        instanceId: op.instanceId,
        credentialKeysetCommitment: op.credentialKeysetCommitment,
      }),
    );
    expect(await getOperation(db, { ...ref, credentialKeysetCommitment: other })).toBeNull();
    expect(
      await getOperationByRequest(db, { ...request, credentialKeysetCommitment: other }),
    ).toBeNull();
    expect(
      await deferDirtyInstance(db, {
        ...dirty,
        credentialKeysetCommitment: other,
        nextAttemptAt: now + 10_000,
      }),
    ).toBe(false);
    expect(await ackDirtyInstance(db, { ...dirty, credentialKeysetCommitment: other })).toBe(false);
    expect(
      await readPassSnapshot(db, {
        ...ref,
        passId: op.passId,
        credentialKeysetCommitment: 'invalid',
      }),
    ).toBeNull();

    for (const replacement of [other, null]) {
      await replaceCallbackKeysetForTest(db, replacement);
      try {
        expect(await getInstanceByPass(db, { ...ref, passId: op.passId })).toBeNull();
        expect(await getInstanceById(db, ref)).toBeNull();
        expect(await getOperation(db, ref)).toBeNull();
        expect(await getOperationByRequest(db, request)).toBeNull();
        expect(await listDueOperations(db, now, 100, null, op.credentialKeysetCommitment)).toEqual(
          [],
        );
        expect(await listDirtyInstances(db, now, 100, null, op.credentialKeysetCommitment)).toEqual(
          [],
        );
        expect(await ackDirtyInstance(db, dirty)).toBe(false);
      } finally {
        await replaceCallbackKeysetForTest(db, op.credentialKeysetCommitment);
      }
    }
    // SQLite text length/GLOB stop at NUL and TEXT affinity permits BLOBs. Neither is a
    // canonical commitment, even if the keyset singleton is itself malformed.
    const malformed = `${op.credentialKeysetCommitment}\0x`;
    const newline = `${op.credentialKeysetCommitment}\n`;
    for (const [table, id, trigger] of [
      ['wallet_provider_instances', op.instanceId, 'wallet_provider_instance_keyset_immutable'],
      ['wallet_provider_instance_operations', op.id, 'wallet_provider_operation_keyset_immutable'],
    ] as const) {
      await withoutTrigger(db, trigger, async () => {
        for (const value of [
          malformed,
          newline,
          new TextEncoder().encode(op.credentialKeysetCommitment),
          'A'.repeat(64),
          'a'.repeat(63),
          'a'.repeat(65),
        ]) {
          await expect(
            run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE id = ?`, [
              value,
              id,
            ]),
          ).rejects.toThrow('CHECK');
        }
      });
    }
    for (const invalid of [malformed, newline]) {
      await replaceCallbackKeysetForTest(db, invalid);
      try {
        const forged = { ...ref, credentialKeysetCommitment: invalid };
        expect(await getInstanceById(db, ref)).toBeNull();
        expect(await getOperation(db, forged)).toBeNull();
        expect(
          await getOperationByRequest(db, { ...forged, requestHash: stored.request_hash }),
        ).toBeNull();
        expect(await readPassSnapshot(db, { ...forged, passId: op.passId })).toBeNull();
        const next = {
          ...op,
          ...forged,
          operationId: crypto.randomUUID(),
          requestHash: await sha256Hex(crypto.randomUUID()),
          expectedVersion: op.version,
          kind: 'upsert' as const,
          now,
        };
        await insertDesiredOperation(db, next);
        expect(
          await first(db, 'SELECT id FROM wallet_provider_instance_operations WHERE id = ?', [
            next.operationId,
          ]),
        ).toBeNull();
        expect(await ackDirtyInstance(db, { ...dirty, credentialKeysetCommitment: invalid })).toBe(
          false,
        );
        expect(
          await deferDirtyInstance(db, {
            ...dirty,
            credentialKeysetCommitment: invalid,
            nextAttemptAt: now + 10_000,
          }),
        ).toBe(false);
      } finally {
        await replaceCallbackKeysetForTest(db, op.credentialKeysetCommitment);
      }
    }
    expect(await deferDirtyInstance(db, { ...dirty, nextAttemptAt: now + 10_000 })).toBe(true);
    expect(await ackDirtyInstance(db, dirty)).toBe(true);
  }, 120_000);

  it('does not adopt or replace null and mismatched historical instance or operation commitments', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const ref = {
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      instanceId: op.instanceId,
      version: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    };
    const stored = await first<{ request_hash: string }>(
      db,
      'SELECT request_hash FROM wallet_provider_instance_operations WHERE id = ?',
      [op.id],
    );
    if (!stored) throw new Error('Missing provider operation');
    const next = {
      ...op,
      operationId: crypto.randomUUID(),
      requestHash: await sha256Hex(crypto.randomUUID()),
      expectedVersion: op.version,
      kind: 'upsert' as const,
      now: t.kit.clock.now(),
    };
    const other =
      op.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);

    for (const [table, id] of [
      ['wallet_provider_instances', op.instanceId],
      ['wallet_provider_instance_operations', op.id],
    ] as const) {
      for (const value of [null, other]) {
        await withStoredCommitment(
          db,
          table,
          id,
          op.credentialKeysetCommitment,
          value,
          async () => {
            if (table === 'wallet_provider_instances') {
              expect(await getInstanceById(db, ref)).toBeNull();
              expect(await getInstanceByPass(db, { ...ref, passId: op.passId })).toBeNull();
            }
            expect(await getOperation(db, ref)).toBeNull();
            expect(
              await getOperationByRequest(db, { ...ref, requestHash: stored.request_hash }),
            ).toBeNull();
            expect(
              await listDueOperations(db, next.now, 100, null, op.credentialKeysetCommitment),
            ).toEqual([]);
            await insertDesiredOperation(db, next);
            expect(
              await first(
                db,
                'SELECT desired_version, desired_operation_id FROM wallet_provider_instances WHERE id = ?',
                [op.instanceId],
              ),
            ).toEqual({ desired_version: op.version, desired_operation_id: op.id });
            expect(
              await first(db, `SELECT credential_keyset_commitment FROM ${table} WHERE id = ?`, [
                id,
              ]),
            ).toEqual({ credential_keyset_commitment: value });
            expect(
              await first(db, 'SELECT id FROM wallet_provider_instance_operations WHERE id = ?', [
                next.operationId,
              ]),
            ).toBeNull();
          },
        );
      }
    }
  }, 120_000);

  it('supersedes only operations carrying the exact original commitment', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const now = t.kit.clock.now();
    const second = {
      ...op,
      operationId: crypto.randomUUID(),
      requestHash: await sha256Hex(crypto.randomUUID()),
      expectedVersion: op.version,
      kind: 'upsert' as const,
      now,
    };
    await insertDesiredOperation(db, second);
    expect(await getOperation(db, { ...second, version: 2 })).toMatchObject({
      id: second.operationId,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
      state: 'pending',
    });

    await withoutTrigger(db, 'wallet_provider_operation_keyset_immutable', async () => {
      // Simulate an older pre-migration pending row alongside the valid current operation.
      await run(
        db,
        `UPDATE wallet_provider_instance_operations SET credential_keyset_commitment = NULL,
        state = 'pending', completed_at = NULL WHERE id = ?`,
        [op.id],
      );
      try {
        const third = {
          ...second,
          operationId: crypto.randomUUID(),
          requestHash: await sha256Hex(crypto.randomUUID()),
          expectedVersion: 2,
        };
        await insertDesiredOperation(db, third);
        expect(
          await all(
            db,
            `SELECT version, state, credential_keyset_commitment FROM wallet_provider_instance_operations
          WHERE instance_id = ? ORDER BY version`,
            [op.instanceId],
          ),
        ).toEqual([
          { version: 1, state: 'pending', credential_keyset_commitment: null },
          {
            version: 2,
            state: 'superseded',
            credential_keyset_commitment: op.credentialKeysetCommitment,
          },
          {
            version: 3,
            state: 'pending',
            credential_keyset_commitment: op.credentialKeysetCommitment,
          },
        ]);
      } finally {
        await run(
          db,
          `UPDATE wallet_provider_instance_operations SET credential_keyset_commitment = ?,
          state = 'superseded', completed_at = ? WHERE id = ?`,
          [op.credentialKeysetCommitment, now, op.id],
        );
      }
    });
  }, 120_000);

  it('guards claims, outcomes and finalization against changed stored commitments', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const now = t.kit.clock.now();
    const claim = {
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      instanceId: op.instanceId,
      version: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
      hash: await sha256Hex(crypto.randomUUID()),
      now,
    };
    const other =
      op.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    expect(await claimOperation(db, { ...claim, credentialKeysetCommitment: other })).toBe(
      'not_claimable',
    );
    expect(await claimOperation(db, claim)).toBe('claimed');
    const id = crypto.randomUUID();
    const envelope = await encryptSecret(
      await loadKekRing(t.kit.env),
      new Uint8Array([1, 2]),
      credentialAad(id, op.orgId, 'wallet.provider.outcome'),
    );
    const outcome = {
      ...claim,
      claimHash: claim.hash,
      operationId: op.id,
      attempt: 1,
      sequence: 1,
      eventHash: await sha256Hex('event'),
      payloadHash: await sha256Hex('payload'),
      id,
      envelope,
      reason: 'ok' as const,
      httpStatus: 200,
    };
    const finish = {
      ...claim,
      operationId: op.id,
      attempt: 1,
      result: { kind: 'success' as const },
    };
    expect(await markUncertain(db, { ...claim, credentialKeysetCommitment: other })).toBe(false);
    expect(await insertOutcome(db, { ...outcome, credentialKeysetCommitment: other })).toBe(
      'stale',
    );
    expect(await finishOperation(db, { ...finish, credentialKeysetCommitment: other })).toBeNull();
    for (const replacement of [other, null]) {
      await replaceCallbackKeysetForTest(db, replacement);
      try {
        expect(await markUncertain(db, claim)).toBe(false);
        expect(await insertOutcome(db, outcome)).toBe('stale');
        expect(await finishOperation(db, finish)).toBeNull();
      } finally {
        await replaceCallbackKeysetForTest(db, op.credentialKeysetCommitment);
      }
    }

    for (const [table, rowId] of [
      ['wallet_provider_instances', op.instanceId],
      ['wallet_provider_instance_operations', op.id],
    ] as const) {
      for (const value of [null, other]) {
        await withStoredCommitment(
          db,
          table,
          rowId,
          op.credentialKeysetCommitment,
          value,
          async () => {
            expect(await insertOutcome(db, outcome)).toBe('stale');
            expect(await finishOperation(db, finish)).toBeNull();
            expect(
              await first(
                db,
                'SELECT state, attempts FROM wallet_provider_instance_operations WHERE id = ?',
                [op.id],
              ),
            ).toEqual({ state: 'claimed', attempts: 1 });
          },
        );
      }
    }
    expect(await insertOutcome(db, outcome)).toBe('recorded');
    expect(await insertOutcome(db, outcome)).toBe('replay');
    expect(await finishOperation(db, finish)).toBe('succeeded');
    expect(await getOperation(db, claim)).toMatchObject({
      state: 'succeeded',
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    });
  }, 120_000);
});

describe('wallet provider due-operation selection', () => {
  it('retains ordering, retry timing, live authority and in-flight exclusion', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const now = t.kit.clock.now();
    const pass = await t.kit.pass();
    const second = await seedHistoricalProviderInstance(db, {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      passId: pass.id,
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      credentialGeneration: op.credentialGeneration,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
      accountId: op.accountId,
      releaseId: op.identityProjectionReleaseId,
      now,
      upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'pending' },
    });
    if (!second) throw new Error('Missing second provider operation');
    const list = async (afterId: string | null = null, limit = 100) =>
      (await listDueOperations(db, now, limit, afterId, op.credentialKeysetCommitment)).map(
        (item) => item.id,
      );
    const sorted = [op.id, second.id].sort();
    const [firstId, secondId] = sorted;
    if (!firstId || !secondId) throw new Error('Missing sorted operation IDs');
    expect(await list()).toEqual(sorted);
    expect(await list(null, 1)).toEqual([firstId]);
    expect(await list(firstId)).toEqual([secondId]);
    expect(await list(secondId)).toEqual([]);

    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'retry', next_attempt_at = ? WHERE id = ?",
      [now + 1_000, op.id],
    );
    expect(await list()).toEqual([second.id]);
    await run(
      db,
      'UPDATE wallet_provider_instance_operations SET next_attempt_at = ? WHERE id = ?',
      [now, op.id],
    );
    expect(await list()).toEqual(sorted);
    await run(db, 'UPDATE wallet_provider_instance_operations SET attempts = 8 WHERE id = ?', [
      op.id,
    ]);
    expect(await list()).toEqual([second.id]);
    await run(db, 'UPDATE wallet_provider_instance_operations SET attempts = 0 WHERE id = ?', [
      op.id,
    ]);

    const claim = {
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      instanceId: op.instanceId,
      version: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
      hash: await sha256Hex(crypto.randomUUID()),
      now,
    };
    expect(await claimOperation(db, claim)).toBe('claimed');
    const next = {
      ...op,
      operationId: crypto.randomUUID(),
      requestHash: await sha256Hex(crypto.randomUUID()),
      expectedVersion: op.version,
      kind: 'upsert' as const,
      now,
    };
    await insertDesiredOperation(db, next);
    expect(await getOperation(db, { ...claim, version: 2 })).toMatchObject({
      id: next.operationId,
      state: 'pending',
    });
    expect(await list()).toEqual([second.id]);
    expect(await markUncertain(db, claim)).toBe(true);
    expect(await list()).toEqual([second.id]);

    // Simulate transport settlement of the older operation before considering its successor.
    await run(
      db,
      `UPDATE wallet_provider_instance_operations
      SET state = 'superseded', claim_hash = NULL, claim_expires_at = NULL WHERE id = ?`,
      [op.id],
    );
    expect(await list()).toEqual([second.id, next.operationId].sort());
    await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [op.passId]);
    expect(await list()).toEqual([second.id]);
    expect(
      await claimOperation(db, {
        ...claim,
        version: 2,
        hash: await sha256Hex(crypto.randomUUID()),
      }),
    ).toBe('not_claimable');
  }, 120_000);

  it('defers only the exact current operation with live projection evidence', async () => {
    const t = await setupSamsungCallbacks({ reference: false, db: (await makeEnv()).DB });
    const db = t.kit.env.DB;
    const op = t.operation;
    const now = t.kit.clock.now();
    const ref = {
      orgId: op.orgId,
      mode: op.mode,
      provider: op.provider,
      instanceId: op.instanceId,
      version: op.version,
      credentialKeysetCommitment: op.credentialKeysetCommitment,
    };
    const other =
      op.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    const evidence = await first<{ expires_at: number }>(
      db,
      `SELECT e.expires_at FROM template_releases r
      JOIN wallet_provider_projection_evidence e ON e.candidate_id = r.candidate_id
      WHERE r.id = ? AND e.status = 'verified'`,
      [op.projectionReleaseId],
    );
    if (!evidence) throw new Error('Missing verified provider evidence');

    expect(
      await deferWalletSyncOperation(db, { ...ref, version: ref.version + 1 }, now, 1_000),
    ).toBe(false);
    expect(
      await deferWalletSyncOperation(db, { ...ref, orgId: crypto.randomUUID() }, now, 1_000),
    ).toBe(false);
    expect(
      await deferWalletSyncOperation(db, { ...ref, credentialKeysetCommitment: other }, now, 1_000),
    ).toBe(false);
    expect(await deferWalletSyncOperation(db, ref, evidence.expires_at, 1_000)).toBe(false);
    expect(await getOperation(db, ref)).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
    });

    expect(await deferWalletSyncOperation(db, ref, now, 1_000)).toBe(true);
    expect(await getOperation(db, ref)).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now + 1_000,
    });
    expect(await listDueOperations(db, now, 10, null, op.credentialKeysetCommitment)).toEqual([]);
    expect(
      (await listDueOperations(db, now + 1_000, 10, null, op.credentialKeysetCommitment)).map(
        (item) => item.id,
      ),
    ).toEqual([op.id]);
    const claim = { ...ref, hash: await sha256Hex(crypto.randomUUID()), now: now + 1_000 };
    expect(await claimOperation(db, claim)).toBe('claimed');
    expect(await deferWalletSyncOperation(db, ref, now + 1_000, 1_000)).toBe(false);
    expect(await getOperation(db, ref)).toMatchObject({ state: 'claimed', attempts: 1 });
    expect(await operationFresh(db, claim)).toBe(true);
    expect(await operationFresh(db, { ...claim, hash: await sha256Hex('other claim') })).toBe(
      false,
    );
    expect(await operationFresh(db, { ...claim, now: claim.now + 119_999 })).toBe(true);
    expect(await operationFresh(db, { ...claim, now: claim.now + 120_000 })).toBe(false);
  }, 120_000);
});
