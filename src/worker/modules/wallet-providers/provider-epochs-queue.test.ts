// PE5a (queue on grants) and PE5b (reconcile writes and the 0149 operation triggers).
import { describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import {
  claimWalletOperation,
  completeWalletOperation,
  getWalletInstanceById,
  getWalletOperation,
  listDueWalletOperations,
  newWalletClaimHandle,
  recordWalletOperationOutcome,
  walletOperationFresh,
} from './instance.ts';
import { fixture, reference } from './instance-test-fixtures.ts';
import { reconcileWalletInstance } from './lifecycle.ts';
import { queueWalletOperation } from './queue-test-fixtures.ts';
import { deferWalletSyncOperation } from './repo-sync-queue.ts';

const bumpPass = (db: D1Database, passId: string) =>
  run(db, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [passId]);
const rowVersion = async (db: D1Database, passId: string) =>
  (await first<{ v: number }>(db, 'SELECT row_version AS v FROM passes WHERE id = ?', [passId]))?.v;

function queueInput(proof: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['current']>>) {
  return {
    ...proof,
    requestKey: crypto.randomUUID(),
    newId: () => crypto.randomUUID(),
  };
}

describe('PE5a: the queue claims on epochs', () => {
  it('claims only while the pass row_version is the one the operation recorded', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const before = await rowVersion(db, f.pass.id);
    await bumpPass(db, f.pass.id);
    expect(await rowVersion(db, f.pass.id)).toBeGreaterThan(before ?? 0);
    expect(await listDueWalletOperations(db, f.kit.clock.now(), 10)).toEqual([]);
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now: f.kit.clock.now() };
    expect(await claimWalletOperation(ctx, claim)).toBe('not_claimable');
    expect(await getWalletOperation(db, reference(op))).toMatchObject({
      state: 'pending',
      attempts: 0,
    });
  });

  it('claims while the account epoch is the one the operation recorded, and stops when it moves', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    // A touch that is not an identity change moves no epoch.
    await run(db, 'UPDATE wallet_provider_accounts SET updated_at = updated_at + 1 WHERE id = ?', [
      op.accountId,
    ]);
    expect((await listDueWalletOperations(db, now, 10)).map((o) => o.id)).toEqual([op.id]);
    await run(
      db,
      'UPDATE wallet_provider_accounts SET authority_epoch = authority_epoch + 1 WHERE id = ?',
      [op.accountId],
    );
    expect(await listDueWalletOperations(db, now, 10)).toEqual([]);
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, claim)).toBe('not_claimable');
  });

  it('keeps one operation in flight per instance', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const first1 = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, first1)).toBe('claimed');
    expect(await claimWalletOperation(ctx, first1)).toBe('already_claimed');
    expect(
      await claimWalletOperation(ctx, { ...first1, claimHandle: newWalletClaimHandle() }),
    ).toBe('not_claimable');
    expect(await getWalletOperation(db, reference(op))).toMatchObject({
      state: 'claimed',
      attempts: 1,
    });
  });

  it('records a provider response and settles a stale operation as superseded, never refusing the result', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const claim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, claim)).toBe('claimed');
    expect(await walletOperationFresh(db, claim)).toBe(true);
    await bumpPass(db, f.pass.id);
    expect(await walletOperationFresh(db, claim)).toBe(false);
    expect(
      await recordWalletOperationOutcome(ctx, {
        ...claim,
        sequence: 1,
        eventKey: '1:update',
        body: new TextEncoder().encode('{}'),
        reason: 'ok',
        httpStatus: 200,
      }),
    ).toBe('recorded');
    expect(await completeWalletOperation(ctx, { ...claim, result: { kind: 'success' } })).toBe(
      'superseded',
    );
    expect(
      await first(
        db,
        'SELECT COUNT(*) AS n FROM wallet_provider_instance_outcomes WHERE operation_id = ?',
        [op.id],
      ),
    ).toEqual({ n: 1 });
  });

  it('runs a revoke for a suspended org but never an upsert', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const revoke = await queueWalletOperation(ctx, {
      ...queueInput(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      now,
    });
    if (!revoke) throw new Error('Revoke not queued');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [f.pass.orgId]);
    const upsertClaim = { ...reference(op), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, upsertClaim)).toBe('not_claimable');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, claim)).toBe('claimed');
    expect(await completeWalletOperation(ctx, { ...claim, result: { kind: 'success' } })).toBe(
      'succeeded',
    );
    expect(await getWalletInstanceById(db, reference(op))).toMatchObject({ lifecycle: 'revoked' });
  });
});

/** The first batch runs `before` first, as a concurrent writer committing between a read and a write. */
function withBatchHook(ctx: ServiceContext, before: () => Promise<void>): ServiceContext {
  let done = false;
  const db = new Proxy(ctx.env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await before();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...ctx, env: { ...ctx.env, DB: db } };
}

describe('PE5b: reconcile writes on grants', () => {
  it('loses no update: a pass that moves between the read and the grant refuses stale, keeps the dirty row, and the next run uses the new version', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const op = await f.create();
    await bumpPass(db, f.pass.id);
    const instance = await getWalletInstanceById(db, reference(op));
    if (!instance) throw new Error('Missing instance');
    const read = await rowVersion(db, f.pass.id);
    const racing = withBatchHook(jobCtxOf(f.kit), async () => {
      await bumpPass(db, f.pass.id);
    });
    expect(await reconcileWalletInstance(racing, instance)).toBe('blocked');
    const moved = await rowVersion(db, f.pass.id);
    expect(moved).toBeGreaterThan(read ?? 0);
    expect(
      await all(
        db,
        'SELECT version FROM wallet_provider_instance_operations WHERE instance_id = ?',
        [op.instanceId],
      ),
    ).toEqual([{ version: 1 }]);
    expect(await getWalletInstanceById(db, reference(op))).toMatchObject({ desiredVersion: 1 });
    expect(
      await first(
        db,
        'SELECT instance_id FROM wallet_provider_instance_dirty WHERE instance_id = ?',
        [op.instanceId],
      ),
    ).toEqual({ instance_id: op.instanceId });
    const latest = await getWalletInstanceById(db, reference(op));
    if (!latest) throw new Error('Missing instance');
    expect(await reconcileWalletInstance(jobCtxOf(f.kit), latest)).toBe('scheduled');
    expect(
      await first(
        db,
        'SELECT version, pass_row_version AS v FROM wallet_provider_instance_operations WHERE instance_id = ? ORDER BY version DESC',
        [op.instanceId],
      ),
    ).toEqual({ version: 2, v: moved });
  });

  it('sends a revoke staged before an edit, even after the pass moves again (D6)', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const staged = await f.current();
    await bumpPass(db, f.pass.id);
    const revoke = await queueWalletOperation(ctx, {
      ...queueInput(staged),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      now,
    });
    if (!revoke) throw new Error('A revoke staged from an older pass snapshot must queue');
    const claim = { ...reference(revoke), claimHandle: newWalletClaimHandle(), now };
    expect(await claimWalletOperation(ctx, claim)).toBe('claimed');
    await bumpPass(db, f.pass.id);
    expect(await walletOperationFresh(db, claim)).toBe(true);
    expect(await completeWalletOperation(ctx, { ...claim, result: { kind: 'success' } })).toBe(
      'succeeded',
    );
  });

  it('refuses an upsert that names a row_version the pass has left, at the grant and at the trigger', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const proof = await f.current();
    await bumpPass(db, f.pass.id);
    expect(
      await queueWalletOperation(ctx, {
        ...queueInput(proof),
        passRowVersion: (await rowVersion(db, f.pass.id))! - 1,
        instanceId: op.instanceId,
        expectedVersion: op.version,
        kind: 'upsert',
        now,
      }),
    ).toBeNull();
    const insert = (rowVersionValue: number | null, epoch: number | null, kind: string) =>
      run(
        db,
        `INSERT INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
         lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
         policy_revision, credential_keyset_commitment, created_at, pass_row_version, account_epoch)
        SELECT ?, o.instance_id, 2, ?, ?, o.pass_version, o.pass_revision, o.pass_credential_generation,
          o.lifecycle_generation, o.issuing_release_id, o.projection_release_id, o.account_revision,
          o.adapter_revision, o.policy_revision, o.credential_keyset_commitment, o.created_at, ?, ?
        FROM wallet_provider_instance_operations o WHERE o.id = ?`,
        [crypto.randomUUID(), kind, 'e'.repeat(64), rowVersionValue, epoch, op.id],
      );
    const current = (await rowVersion(db, f.pass.id)) ?? 0;
    const epoch =
      (
        await first<{ e: number }>(
          db,
          'SELECT authority_epoch AS e FROM wallet_provider_accounts WHERE id = ?',
          [op.accountId],
        )
      )?.e ?? 0;
    await expect(insert(current - 1, epoch, 'upsert')).rejects.toThrow(
      /provider operation is not authorized/,
    );
    await expect(insert(current, epoch + 1, 'upsert')).rejects.toThrow(
      /provider operation is not authorized/,
    );
    await expect(insert(null, null, 'upsert')).rejects.toThrow(
      /provider operation is not authorized/,
    );
    // A revoke is lineage only: it names neither a pass version nor an account epoch.
    await insert(null, null, 'revoke');
    expect(
      await first(
        db,
        'SELECT kind FROM wallet_provider_instance_operations WHERE version = 2 AND instance_id = ?',
        [op.instanceId],
      ),
    ).toEqual({ kind: 'revoke' });
  });
});

describe('review fixes: deferral', () => {
  it('defers a suspended org revoke so it leaves the head of the queue', async () => {
    const f = await fixture();
    const db = f.kit.env.DB;
    const ctx = jobCtxOf(f.kit);
    const op = await f.create();
    const now = f.kit.clock.now();
    const revoke = await queueWalletOperation(ctx, {
      ...queueInput(await f.current()),
      instanceId: op.instanceId,
      expectedVersion: op.version,
      kind: 'revoke',
      now,
    });
    if (!revoke) throw new Error('Revoke not queued');
    await run(db, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [f.pass.orgId]);
    const mine = async (at: number) =>
      (await listDueWalletOperations(db, at, 50))
        .filter((o) => o.instanceId === op.instanceId)
        .map((o) => o.id);
    expect(await mine(now)).toEqual([revoke.id]);
    expect(await deferWalletSyncOperation(ctx, reference(revoke), now, 60_000)).toBe(true);
    expect(await mine(now)).toEqual([]);
    expect(await mine(now + 60_000)).toEqual([revoke.id]);
  });
});
