import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { replaceCallbackKeysetForTest, setupSamsungCallbacks } from './callbacks-test-fixtures.ts';
import { darkRows } from './release-test-fixtures.ts';
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
import { walletJobCtx } from './wallet-job-ctx-test-fixtures.ts';

const makeEnv = installKeysetTestEnv();

async function withoutTrigger(
  db: D1Database,
  name:
    | 'wallet_provider_generation_insert_guard'
    | 'wallet_provider_generation_operation_draining'
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
    await darkRows(db);
    const pass = await t.kit.pass();
    const snapshot = await readPassSnapshot(db, {
      orgId: t.operation.orgId,
      mode: t.operation.mode,
      passId: pass.id,
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
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE id = ?', [input.instanceId]),
    ).toBeNull();
    await expect(insertInstance(db, input)).rejects.toThrow('provider issuance is unavailable');

    // Isolate repository persistence without changing the real, independently closed provider gates.
    // The release rule on operations (0229) is lifted too: the offer and insert guards are what this case reads.
    await withoutTrigger(db, 'wallet_provider_generation_operation_draining', () =>
      withoutTrigger(db, 'wallet_provider_generation_insert_guard', async () => {
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
        });
        expect(await getOperation(db, { ...input, version: 1 })).toMatchObject({
          id: input.operationId,
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
          instance_commitment: t.credentialKeysetCommitment,
          operation_commitment: t.credentialKeysetCommitment,
        });
      }),
    );
  });

  it('returns only rows of the pinned keyset on reads and dirty work', async () => {
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
    };
    const other = t.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
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
    });
    expect(await getInstanceById(db, ref)).toMatchObject({ id: op.instanceId });
    expect(await getOperation(db, ref)).toMatchObject({ id: op.id });
    expect(await getOperationByRequest(db, request)).toMatchObject({ id: op.id });
    expect(await readPassSnapshot(db, { ...ref, passId: op.passId })).toMatchObject({
      passId: op.passId,
    });
    expect(await listDueOperations(db, now, 100, null)).toContainEqual(
      expect.objectContaining({
        id: op.id,
      }),
    );
    expect(await listDirtyInstances(db, now, 100, null)).toContainEqual(
      expect.objectContaining({
        instanceId: op.instanceId,
      }),
    );
    // SQLite text length/GLOB stop at NUL and TEXT affinity permits BLOBs. Neither is a
    // canonical commitment, even if the keyset singleton is itself malformed.
    const malformed = `${t.credentialKeysetCommitment}\0x`;
    const newline = `${t.credentialKeysetCommitment}\n`;
    for (const [table, id, trigger] of [
      ['wallet_provider_instances', op.instanceId, 'wallet_provider_instance_keyset_immutable'],
      ['wallet_provider_instance_operations', op.id, 'wallet_provider_operation_keyset_immutable'],
    ] as const) {
      await withoutTrigger(db, trigger, async () => {
        for (const value of [
          malformed,
          newline,
          new TextEncoder().encode(t.credentialKeysetCommitment),
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
    for (const invalid of [other, malformed, newline]) {
      await replaceCallbackKeysetForTest(db, invalid);
      try {
        expect(await getOperation(db, ref)).toBeNull();
        expect(await getOperationByRequest(db, request)).toBeNull();
        expect(await listDueOperations(db, now, 100, null)).toEqual([]);
        expect(await listDirtyInstances(db, now, 100, null)).toEqual([]);
        const next = {
          ...op,
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
        expect(await ackDirtyInstance(db, dirty)).toBe(false);
        expect(await deferDirtyInstance(db, { ...dirty, nextAttemptAt: now + 10_000 })).toBe(false);
      } finally {
        await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
      }
    }
    expect(await deferDirtyInstance(db, { ...dirty, nextAttemptAt: now + 10_000 })).toBe(true);
    expect(await ackDirtyInstance(db, dirty)).toBe(true);
  });

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
    const other = t.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);

    for (const [table, id] of [
      ['wallet_provider_instances', op.instanceId],
      ['wallet_provider_instance_operations', op.id],
    ] as const) {
      for (const value of [null, other]) {
        await withStoredCommitment(db, table, id, t.credentialKeysetCommitment, value, async () => {
          expect(await getOperation(db, ref)).toBeNull();
          expect(
            await getOperationByRequest(db, { ...ref, requestHash: stored.request_hash }),
          ).toBeNull();
          expect(await listDueOperations(db, next.now, 100, null)).toEqual([]);
          await insertDesiredOperation(db, next);
          expect(
            await first(
              db,
              'SELECT desired_version, desired_operation_id FROM wallet_provider_instances WHERE id = ?',
              [op.instanceId],
            ),
          ).toEqual({ desired_version: op.version, desired_operation_id: op.id });
          expect(
            await first(db, `SELECT credential_keyset_commitment FROM ${table} WHERE id = ?`, [id]),
          ).toEqual({ credential_keyset_commitment: value });
          expect(
            await first(db, 'SELECT id FROM wallet_provider_instance_operations WHERE id = ?', [
              next.operationId,
            ]),
          ).toBeNull();
        });
      }
    }
  });

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
            credential_keyset_commitment: t.credentialKeysetCommitment,
          },
          {
            version: 3,
            state: 'pending',
            credential_keyset_commitment: t.credentialKeysetCommitment,
          },
        ]);
      } finally {
        await run(
          db,
          `UPDATE wallet_provider_instance_operations SET credential_keyset_commitment = ?,
          state = 'superseded', completed_at = ? WHERE id = ?`,
          [t.credentialKeysetCommitment, now, op.id],
        );
      }
    });
  });

  it('refuses rows stored under another keyset on claims, outcomes and finalization', async () => {
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
      hash: await sha256Hex(crypto.randomUUID()),
      now,
    };
    const other = t.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    expect(await claimOperation(walletJobCtx(db), claim)).toBe('claimed');
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
    for (const [table, rowId] of [
      ['wallet_provider_instances', op.instanceId],
      ['wallet_provider_instance_operations', op.id],
    ] as const) {
      for (const value of [null, other]) {
        await withStoredCommitment(
          db,
          table,
          rowId,
          t.credentialKeysetCommitment,
          value,
          async () => {
            expect(await insertOutcome(walletJobCtx(db), outcome)).toBe('stale');
            expect(await finishOperation(walletJobCtx(db), finish)).toBeNull();
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
    expect(await insertOutcome(walletJobCtx(db), outcome)).toBe('recorded');
    expect(await insertOutcome(walletJobCtx(db), outcome)).toBe('replay');
    expect(await finishOperation(walletJobCtx(db), finish)).toBe('succeeded');
    expect(await getOperation(db, claim)).toMatchObject({
      state: 'succeeded',
    });
  });
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
      credentialKeysetCommitment: t.credentialKeysetCommitment,
      accountId: op.accountId,
      releaseId: op.identityProjectionReleaseId,
      now,
      upsert: { requestHash: await sha256Hex(crypto.randomUUID()), state: 'pending' },
    });
    if (!second) throw new Error('Missing second provider operation');
    const list = async (afterId: string | null = null, limit = 100) =>
      (await listDueOperations(db, now, limit, afterId)).map((item) => item.id);
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
      hash: await sha256Hex(crypto.randomUUID()),
      now,
    };
    expect(await claimOperation(walletJobCtx(db), claim)).toBe('claimed');
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
    expect(await markUncertain(walletJobCtx(db), claim)).toBe(true);
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
      await claimOperation(walletJobCtx(db), {
        ...claim,
        version: 2,
        hash: await sha256Hex(crypto.randomUUID()),
      }),
    ).toBe('not_claimable');
  });

  it('defers only the exact current operation', async () => {
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
    };
    const other = t.credentialKeysetCommitment === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
    expect(
      await deferWalletSyncOperation(
        walletJobCtx(db),
        { ...ref, version: ref.version + 1 },
        now,
        1_000,
      ),
    ).toBe(false);
    expect(
      await deferWalletSyncOperation(
        walletJobCtx(db),
        { ...ref, orgId: crypto.randomUUID() },
        now,
        1_000,
      ),
    ).toBe(false);
    await replaceCallbackKeysetForTest(db, other);
    try {
      expect(await deferWalletSyncOperation(walletJobCtx(db), ref, now, 1_000)).toBe(false);
    } finally {
      await replaceCallbackKeysetForTest(db, t.credentialKeysetCommitment);
    }
    // D8: the evidence expiry is no longer a queue predicate; reconcile and publish check it.
    expect(await getOperation(db, ref)).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
    });

    expect(await deferWalletSyncOperation(walletJobCtx(db), ref, now, 1_000)).toBe(true);
    expect(await getOperation(db, ref)).toMatchObject({
      state: 'pending',
      attempts: 0,
      nextAttemptAt: now + 1_000,
    });
    expect(await listDueOperations(db, now, 10, null)).toEqual([]);
    expect((await listDueOperations(db, now + 1_000, 10, null)).map((item) => item.id)).toEqual([
      op.id,
    ]);
    const claim = { ...ref, hash: await sha256Hex(crypto.randomUUID()), now: now + 1_000 };
    expect(await claimOperation(walletJobCtx(db), claim)).toBe('claimed');
    expect(await deferWalletSyncOperation(walletJobCtx(db), ref, now + 1_000, 1_000)).toBe(false);
    expect(await getOperation(db, ref)).toMatchObject({ state: 'claimed', attempts: 1 });
    expect(await operationFresh(db, claim)).toBe(true);
    expect(await operationFresh(db, { ...claim, hash: await sha256Hex('other claim') })).toBe(
      false,
    );
    expect(await operationFresh(db, { ...claim, now: claim.now + 119_999 })).toBe(true);
    expect(await operationFresh(db, { ...claim, now: claim.now + 120_000 })).toBe(false);
    // WA5: a platform hold on the enrolment (the kill switch, legacy rows too) ends an in-flight upsert.
    for (const { name } of await all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_provider_accounts'",
    ))
      await run(db, `DROP TRIGGER ${name}`);
    await run(
      db,
      'UPDATE wallet_provider_accounts SET platform_hold_at = ? WHERE org_id = ? AND mode = ? AND provider = ?',
      [claim.now, claim.orgId, claim.mode, claim.provider],
    );
    expect(await operationFresh(db, claim)).toBe(false);
  });
});
