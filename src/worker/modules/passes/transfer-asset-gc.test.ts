import { describe, expect, it, vi } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { brandingKey } from '../orgs/branding-files.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { ICON_PNG, type Kit, setupKit } from './pass-test-fixtures.ts';
import {
  acknowledgeRetiredPassAssetKey,
  claimRetiredPassAssetKey,
  recoverExpiredPassAssetCandidate,
  retireUnusedPassAssetKey,
} from './repo-transfer-asset-gc.ts';
import {
  sweepOneTransferAssetGc,
  sweepTransferAssetGc,
  TRANSFER_ASSET_GC_BATCH_SIZE,
  TRANSFER_ASSET_GC_LEASE_MS,
  TRANSFER_ASSET_GC_MAX_RECHECKS,
  TRANSFER_ASSET_GC_RECHECK_MS,
  TRANSFER_ASSET_GC_RETRY_MS,
  TRANSFER_ASSET_STAGE_LEASE_MS,
  TRANSFER_ASSET_UPLOAD_LEASE_MS,
} from './transfer-asset-gc.ts';

const system = { type: 'system', id: null } as const;
const target = { holderEmail: 'new-holder@example.test', ownerUserId: null } as const;
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

async function begin(kit: Kit, passId: string) {
  const expected = await getHolderPass(kit.env.DB, passId, null);
  if (!expected) throw new Error('Missing source pass');
  return startCredentialTransfer(jobCtxOf(kit), system, passId, target, null, {
    kind: 'tenant-holder',
    expected,
  });
}

async function asset(kit: Kit, passId: string, key: string, name = 'logo.png') {
  await run(
    kit.env.DB,
    `INSERT INTO pass_assets
    (pass_id,name,r2_key,sha1,size,width,height,crc32,created_at) VALUES (?,?,?,'sha',1,38,38,0,?)`,
    [passId, name, key, kit.clock.now()],
  );
}
async function photo(kit: Kit, passId: string, orgId: string, key: string) {
  await run(
    kit.env.DB,
    `INSERT INTO member_photos
    (pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at)
    VALUES (?,?,?,'sha',1,0,0,'original',?)`,
    [passId, orgId, key, kit.clock.now()],
  );
}

// Fail the final audit inside the real D1 batch, after asset retirement, without changing schema.
function failTransferCompletionAudit(db: D1Database, passId: string): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^\s*INSERT INTO audit_log\b/.test(sql)) return statement;
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === 'bind')
                return (...values: unknown[]) => {
                  if (values.includes('pass.transfer_completed') && values.includes(passId))
                    return target
                      .prepare("SELECT json_extract('[0]', '$[forced transfer rollback]')")
                      .bind();
                  return prepared.bind(...values);
                };
              const value = Reflect.get(prepared, method, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('transfer asset garbage collection', () => {
  it('retires only the transferred rows, fences both tables and preserves shared references', async () => {
    const kit = await setupKit();
    const old = await kit.pass();
    const other = await kit.pass();
    const shared = `pass-assets/${old.id}/logo.png/shared.png`;
    const privatePhoto = `member-photos/${old.orgId}/${old.id}/private.png`;
    await kit.env.BUCKET.put(shared, ICON_PNG);
    await kit.env.BUCKET.put(privatePhoto, ICON_PNG);
    await asset(kit, old.id, shared);
    await photo(kit, old.id, old.orgId, privatePhoto);
    // A pre-existing cross-table reference belongs to an unrelated active pass.
    await photo(kit, other.id, other.orgId, shared);

    const transfer = await begin(kit, old.id);
    expect(transfer.state).toBe('completed');
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [old.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [old.id]),
    ).toBeNull();
    expect(
      await all(
        kit.env.DB,
        `SELECT r2_key,transfer_id,source_pass_id FROM pass_transfer_asset_gc
      WHERE source_pass_id = ? ORDER BY r2_key`,
        [old.id],
      ),
    ).toEqual([
      { r2_key: privatePhoto, transfer_id: transfer.transferId, source_pass_id: old.id },
      { r2_key: shared, transfer_id: transfer.transferId, source_pass_id: old.id },
    ]);
    await expect(asset(kit, old.id, shared)).rejects.toThrow('retired pass asset key');
    await expect(photo(kit, old.id, old.orgId, privatePhoto)).rejects.toThrow(
      'retired pass asset key',
    );
    await expect(
      run(kit.env.DB, 'UPDATE member_photos SET pass_id = ? WHERE pass_id = ?', [old.id, other.id]),
    ).rejects.toThrow('retired pass asset key');
    await run(kit.env.DB, "UPDATE member_photos SET version = 'unchanged-key' WHERE pass_id = ?", [
      other.id,
    ]);
    await sweepOneTransferAssetGc(jobCtxOf(kit), shared);
    await sweepOneTransferAssetGc(jobCtxOf(kit), privatePhoto);
    expect(await kit.env.BUCKET.head(shared)).not.toBeNull();
    expect(await kit.env.BUCKET.head(privatePhoto)).toBeNull();
    await run(kit.env.DB, 'DELETE FROM member_photos WHERE pass_id = ?', [other.id]);
    const holds = await all<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [other.id, shared],
    );
    for (const hold of holds)
      await retireUnusedPassAssetKey(kit.env.DB, {
        key: shared,
        now: kit.clock.now(),
        passId: other.id,
        candidateId: hold.id,
      });
    await sweepOneTransferAssetGc(jobCtxOf(kit), shared);
    expect(await kit.env.BUCKET.head(shared)).toBeNull();
    await expect(
      run(kit.env.DB, 'DELETE FROM pass_transfer_asset_gc WHERE r2_key = ?', [shared]),
    ).rejects.toThrow();
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO pass_transfer_asset_gc
      (r2_key,retired_at,next_attempt_at) VALUES (?,0,0)`,
        [shared],
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('rolls back retirement when a later statement in the final transfer transaction fails', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/logo.png/rollback.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, pass.id, key);
    const sourceSql = `SELECT version,revision,holder_email,owner_user_id,serial,auth_token,object_key,image_generation
      FROM passes WHERE id = ?`;
    const source = await first(kit.env.DB, sourceSql, [pass.id]);
    expect(source).not.toBeNull();
    const faultyEnv = { ...kit.env, DB: failTransferCompletionAudit(kit.env.DB, pass.id) };
    const faultyKit = { ...kit, ctx: { ...jobCtxOf(kit), env: faultyEnv } };
    const logError = vi.spyOn(kit.ctx.log, 'error');
    try {
      const pending = await begin(faultyKit, pass.id);
      expect(pending.state).toBe('pending');
      expect(logError).toHaveBeenCalledWith(
        'pass.transfer_finish_deferred',
        expect.objectContaining({
          transferId: pending.transferId,
          passId: pass.id,
          code: 'TRANSFER_DEFERRED',
          error: expect.objectContaining({
            message: expect.stringContaining('forced transfer rollback'),
          }),
        }),
      );
      expect(await first(kit.env.DB, sourceSql, [pass.id])).toEqual(source);
      expect(
        await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toEqual({ r2_key: key });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT state FROM pass_credential_transfers WHERE pass_id = ?', [
          pass.id,
        ]),
      ).toEqual({ state: 'pending' });
      expect(
        await first(
          kit.env.DB,
          "SELECT 1 FROM audit_log WHERE action = 'pass.transfer_completed' AND target_id = ?",
          [pass.id],
        ),
      ).toBeNull();
      expect(await kit.env.BUCKET.head(key)).not.toBeNull();

      expect(await finishCredentialTransfer(jobCtxOf(kit), pending.transferId)).toEqual({
        transferId: pending.transferId,
        state: 'completed',
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT transfer_id,source_pass_id FROM pass_transfer_asset_gc WHERE r2_key = ?',
          [key],
        ),
      ).toEqual({ transfer_id: pending.transferId, source_pass_id: pass.id });
      expect(await kit.env.BUCKET.head(key)).not.toBeNull();
      await sweepOneTransferAssetGc(jobCtxOf(kit), key);
      expect(await kit.env.BUCKET.head(key)).toBeNull();
      expect(
        await first(
          kit.env.DB,
          'SELECT last_deleted_at FROM pass_transfer_asset_gc WHERE r2_key = ?',
          [key],
        ),
      ).toEqual({ last_deleted_at: kit.clock.now() });
    } finally {
      logError.mockRestore();
    }
  }, 120_000);

  it('leaves all assets live on a lost source snapshot and retires the new snapshot only on retry', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/logo.png/source.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, pass.id, key);
    const entered = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi
      .spyOn(kit.env.BUCKET, 'put')
      .mockImplementation(async (objectKey, bytes, options) => {
        if (objectKey.startsWith(`passes/${pass.id}/`)) {
          entered.resolve();
          await gate.promise;
        }
        return original(objectKey, bytes, options);
      });
    try {
      const work = begin(kit, pass.id);
      await entered.promise;
      await run(kit.env.DB, "UPDATE pass_assets SET sha1 = 'changed' WHERE pass_id = ?", [pass.id]);
      gate.resolve();
      const pending = await work;
      expect(pending.state).toBe('pending');
      expect(
        await first(kit.env.DB, 'SELECT sha1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toEqual({ sha1: 'changed' });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
      ).toBeNull();
      expect(await kit.env.BUCKET.head(key)).not.toBeNull();
      expect((await finishCredentialTransfer(jobCtxOf(kit), pending.transferId)).state).toBe(
        'completed',
      );
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
      ).not.toBeNull();
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);

  it('blocks references racing the R2 deletion and collects a late stale PUT on a later sweep', async () => {
    const kit = await setupKit();
    const old = await kit.pass();
    const other = await kit.pass();
    const key = `pass-assets/${old.id}/logo.png/late.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, old.id, key);
    expect((await begin(kit, old.id)).state).toBe('completed');
    const entered = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.delete.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'delete').mockImplementation(async (objectKey) => {
      if (objectKey === key) {
        entered.resolve();
        await gate.promise;
      }
      return original(objectKey);
    });
    try {
      const sweeping = sweepOneTransferAssetGc(jobCtxOf(kit), key);
      await entered.promise;
      await expect(asset(kit, other.id, key)).rejects.toThrow('retired pass asset key');
      await expect(photo(kit, other.id, other.orgId, key)).rejects.toThrow(
        'retired pass asset key',
      );
      const assets = JSON.stringify([{ source: { kind: 'r2', key } }]);
      await expect(
        run(
          kit.env.DB,
          `INSERT INTO template_versions
        (template_id,version,manifest,pass_json,assets,report,created_by,created_at)
        SELECT template_id,version || '-gc-race',manifest,pass_json,?,report,created_by,created_at
        FROM template_versions WHERE template_id = ? AND version = ?`,
          [assets, kit.template.id, kit.template.version],
        ),
      ).rejects.toThrow('retired pass asset key');
      gate.resolve();
      await sweeping;
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
    expect(await kit.env.BUCKET.head(key)).toBeNull();
    // A writer that started before the transfer may complete its PUT after the acknowledgement.
    await kit.env.BUCKET.put(key, ICON_PNG);
    await expect(asset(kit, old.id, key)).rejects.toThrow('retired pass asset key');
    kit.clock.advance(TRANSFER_ASSET_GC_RECHECK_MS);
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  }, 120_000);

  describe('ambiguous claim and R2 recovery', () => {
    const makeEnv = installKeysetTestEnv();

    it('keeps a lease on an ambiguous claim and retries R2 failures without losing the tombstone', async () => {
      const env = await makeEnv();
      const clock = new ManualClock();
      const ctx = createServiceContext(env, { clock });
      const key = `pass-assets/${ctx.ids.id()}/logo.png/io.png`;
      const db = env.DB;
      await env.BUCKET.put(key, ICON_PNG);
      await retireUnusedPassAssetKey(db, { key, now: clock.now() });
      const lost = interveneAtD1(
        db,
        {
          method: 'first',
          sql: /UPDATE pass_transfer_asset_gc AS gc\s+SET claim_token = \?1/,
          when: 'after',
        },
        async () => {
          throw new Error('claim response lost');
        },
      );
      const faultyCtx = { ...ctx, env: { ...env, DB: lost.db } };
      const row = () =>
        first(
          db,
          `SELECT claim_token,claim_until,attempts,last_deleted_at,next_attempt_at
          FROM pass_transfer_asset_gc WHERE r2_key = ?`,
          [key],
        );
      await sweepTransferAssetGc(faultyCtx);
      expect(lost.hits()).toBe(1);
      expect(await env.BUCKET.head(key)).not.toBeNull();
      const lease = await row();
      expect(lease).toEqual({
        claim_token: expect.any(String),
        claim_until: clock.now() + TRANSFER_ASSET_GC_LEASE_MS,
        attempts: 1,
        last_deleted_at: null,
        next_attempt_at: clock.now(),
      });

      clock.advance(TRANSFER_ASSET_GC_LEASE_MS - 1);
      await sweepOneTransferAssetGc(ctx, key);
      expect(await env.BUCKET.head(key)).not.toBeNull();
      expect(await row()).toEqual(lease);
      clock.advance(2);

      const original = env.BUCKET.delete.bind(env.BUCKET);
      const spy = vi.spyOn(env.BUCKET, 'delete').mockImplementationOnce(async (objectKey) => {
        await original(objectKey);
        throw new Error('R2 response lost');
      });
      try {
        await sweepOneTransferAssetGc(ctx, key);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await env.BUCKET.head(key)).toBeNull();
        const failed = await row();
        expect(failed).toEqual({
          claim_token: null,
          claim_until: null,
          attempts: 2,
          last_deleted_at: null,
          next_attempt_at: clock.now() + TRANSFER_ASSET_GC_RETRY_MS,
        });
        clock.advance(TRANSFER_ASSET_GC_RETRY_MS - 1);
        await sweepOneTransferAssetGc(ctx, key);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await row()).toEqual(failed);

        clock.advance(1);
        await sweepOneTransferAssetGc(ctx, key);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(await row()).toEqual({
          claim_token: null,
          claim_until: null,
          attempts: 0,
          last_deleted_at: clock.now(),
          next_attempt_at: clock.now() + TRANSFER_ASSET_GC_RECHECK_MS,
        });
      } finally {
        spy.mockRestore();
      }
    }, 120_000);
  });

  it('never deletes unknown namespaces and caps a sweep even with a larger due backlog', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const branding = brandingKey(pass.orgId, 'logo', 3);
    await kit.env.BUCKET.put(branding, ICON_PNG);
    await asset(kit, pass.id, branding);
    expect((await begin(kit, pass.id)).state).toBe('completed');
    await sweepOneTransferAssetGc(jobCtxOf(kit), branding);
    expect(await kit.env.BUCKET.head(branding)).not.toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT deletion_eligible FROM pass_transfer_asset_gc WHERE r2_key = ?',
        [branding],
      ),
    ).toEqual({ deletion_eligible: 0 });

    const prefix = `pass-assets/${kit.ctx.ids.id()}/logo.png/`;
    const keys = Array.from(
      { length: TRANSFER_ASSET_GC_BATCH_SIZE + 3 },
      (_, i) => `${prefix}${i}`,
    );
    for (const key of keys) {
      await kit.env.BUCKET.put(key, ICON_PNG);
      await retireUnusedPassAssetKey(kit.env.DB, { key, now: kit.clock.now() });
    }
    const original = kit.env.BUCKET.delete.bind(kit.env.BUCKET);
    const deleted: string[] = [];
    const spy = vi.spyOn(kit.env.BUCKET, 'delete').mockImplementation(async (key) => {
      if (typeof key === 'string' && key.startsWith(prefix)) deleted.push(key);
      return original(key);
    });
    try {
      await sweepTransferAssetGc(jobCtxOf(kit));
      expect(deleted.length).toBeGreaterThan(0);
      expect(deleted.length).toBeLessThanOrEqual(TRANSFER_ASSET_GC_BATCH_SIZE);
      for (let i = 0; i < 5 && deleted.length < keys.length; i++)
        await sweepTransferAssetGc(jobCtxOf(kit));
      expect(new Set(deleted)).toEqual(new Set(keys));
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});

describe('retired asset reference and lease fences', () => {
  it('retires ordinary cleanup keys only after all asset and photo owners release them', async () => {
    const kit = await setupKit();
    const one = await kit.pass();
    const two = await kit.pass();
    const key = `pass-assets/${one.id}/logo.png/shared-cleanup.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, one.id, key);
    await photo(kit, two.id, two.orgId, key);
    await retireUnusedPassAssetKey(kit.env.DB, { key, now: kit.clock.now() });
    await run(kit.env.DB, 'DELETE FROM pass_assets WHERE pass_id = ?', [one.id]);
    const firstHold = await first<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [one.id, key],
    );
    if (!firstHold) throw new Error('Missing asset rollback hold');
    await retireUnusedPassAssetKey(kit.env.DB, {
      key,
      now: kit.clock.now(),
      passId: one.id,
      candidateId: firstHold.id,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
    ).not.toBeNull();
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    await run(kit.env.DB, 'DELETE FROM member_photos WHERE pass_id = ?', [two.id]);
    const secondHold = await first<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [two.id, key],
    );
    if (!secondHold) throw new Error('Missing photo rollback hold');
    await retireUnusedPassAssetKey(kit.env.DB, {
      key,
      now: kit.clock.now(),
      passId: two.id,
      candidateId: secondHold.id,
    });
    await expect(asset(kit, one.id, key)).rejects.toThrow('retired pass asset key');
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  }, 120_000);

  it('preserves an asset namespace key already referenced by a template version', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/logo.png/template-shared.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, pass.id, key);
    await run(
      kit.env.DB,
      `INSERT INTO template_versions
      (template_id,version,manifest,pass_json,assets,report,created_by,created_at)
      SELECT template_id,version || '-gc-shared',manifest,pass_json,?,report,created_by,created_at
      FROM template_versions WHERE template_id = ? AND version = ?`,
      [JSON.stringify([{ source: { kind: 'r2', key } }]), kit.template.id, kit.template.version],
    );
    expect((await begin(kit, pass.id)).state).toBe('completed');
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    await run(kit.env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
      kit.template.id,
      `${kit.template.version}-gc-shared`,
    ]);
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  }, 120_000);

  it('does not let an expired claimant acknowledge or release a newer claim', async () => {
    const kit = await setupKit();
    const key = `pass-assets/${kit.ctx.ids.id()}/logo.png/lease.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    const now = kit.clock.now();
    await retireUnusedPassAssetKey(kit.env.DB, { key, now });
    expect(
      await claimRetiredPassAssetKey(kit.env.DB, { key, token: 'old', now, until: now + 100 }),
    ).toBe(true);
    expect(
      await claimRetiredPassAssetKey(kit.env.DB, { key, token: 'new', now, until: now + 200 }),
    ).toBe(false);
    kit.clock.advance(101);
    const retryAt = kit.clock.now();
    expect(
      await claimRetiredPassAssetKey(kit.env.DB, {
        key,
        token: 'new',
        now: retryAt,
        until: retryAt + 1000,
      }),
    ).toBe(true);
    await acknowledgeRetiredPassAssetKey(kit.env.DB, {
      key,
      token: 'old',
      now: retryAt,
      nextAttemptAt: retryAt + 5000,
      maxRechecks: TRANSFER_ASSET_GC_MAX_RECHECKS,
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT claim_token,last_deleted_at FROM pass_transfer_asset_gc WHERE r2_key = ?',
        [key],
      ),
    ).toEqual({ claim_token: 'new', last_deleted_at: null });
    await kit.env.BUCKET.delete(key);
    await acknowledgeRetiredPassAssetKey(kit.env.DB, {
      key,
      token: 'new',
      now: retryAt,
      nextAttemptAt: retryAt + 5000,
      maxRechecks: TRANSFER_ASSET_GC_MAX_RECHECKS,
    });
    expect(
      await first(
        kit.env.DB,
        'SELECT claim_token,last_deleted_at FROM pass_transfer_asset_gc WHERE r2_key = ?',
        [key],
      ),
    ).toEqual({ claim_token: null, last_deleted_at: retryAt });
  }, 120_000);
});

it('does not retire anything when START loses its source snapshot', async () => {
  const kit = await setupKit();
  const pass = await kit.pass();
  const expected = await getHolderPass(kit.env.DB, pass.id, null);
  if (!expected) throw new Error('Missing source pass');
  const assetKey = `pass-assets/${pass.id}/logo.png/start.png`;
  const photoKey = `member-photos/${pass.orgId}/${pass.id}/start.png`;
  await kit.env.BUCKET.put(assetKey, ICON_PNG);
  await kit.env.BUCKET.put(photoKey, ICON_PNG);
  await asset(kit, pass.id, assetKey);
  await photo(kit, pass.id, pass.orgId, photoKey);
  await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
  await expect(
    startCredentialTransfer(jobCtxOf(kit), system, pass.id, target, null, {
      kind: 'tenant-holder',
      expected,
    }),
  ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
  expect(
    await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
  ).toEqual({ r2_key: assetKey });
  expect(
    await first(kit.env.DB, 'SELECT r2_key FROM member_photos WHERE pass_id = ?', [pass.id]),
  ).toEqual({ r2_key: photoKey });
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key IN (?, ?)', [
      assetKey,
      photoKey,
    ]),
  ).toBeNull();
  expect(await kit.env.BUCKET.head(assetKey)).not.toBeNull();
  expect(await kit.env.BUCKET.head(photoKey)).not.toBeNull();
}, 120_000);

it('retries after a crash between an R2 delete and its D1 acknowledgement', async () => {
  const kit = await setupKit();
  const key = `member-photos/${kit.org.id}/${kit.ctx.ids.id()}/ack.png`;
  await kit.env.BUCKET.put(key, ICON_PNG);
  await retireUnusedPassAssetKey(kit.env.DB, { key, now: kit.clock.now() });
  const db = kit.env.DB;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (prop === 'run' && sql.includes('last_deleted_at = ?1'))
          return async () => {
            throw new Error('acknowledgement interrupted');
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const interrupted = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const ctx = { ...jobCtxOf(kit), env: { ...kit.env, DB: interrupted } };
  await expect(sweepOneTransferAssetGc(ctx, key)).rejects.toThrow('acknowledgement interrupted');
  expect(await kit.env.BUCKET.head(key)).toBeNull();
  expect(
    await first(
      db,
      'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ? AND claim_token IS NOT NULL',
      [key],
    ),
  ).not.toBeNull();
  kit.clock.advance(TRANSFER_ASSET_GC_LEASE_MS + 1);
  await sweepOneTransferAssetGc(jobCtxOf(kit), key);
  expect(
    await first(db, 'SELECT last_deleted_at FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
  ).toEqual({ last_deleted_at: kit.clock.now() });
}, 120_000);

describe('upload and operation-specific rollback holds', () => {
  async function reserve(kit: Kit, passId: string, key: string) {
    await run(
      kit.env.DB,
      `INSERT INTO pass_transfer_asset_uploads
      (r2_key,pass_id,credential_generation,lifecycle_generation,link_generation,pass_version,pass_revision,created_at)
      SELECT ?,id,credential_generation,lifecycle_generation,link_generation,version,revision,?
      FROM passes WHERE id = ?`,
      [key, kit.clock.now(), passId],
    );
  }

  it('rejects a reservation for a referenced key or a stale pass generation', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const live = `pass-assets/${pass.id}/logo.png/live.png`;
    await asset(kit, pass.id, live);
    await expect(reserve(kit, pass.id, live)).rejects.toThrow('image upload key unavailable');
    const snapshot = await first<{
      credential_generation: number;
      lifecycle_generation: number;
      link_generation: number;
      version: number;
      revision: number;
    }>(
      kit.env.DB,
      `SELECT credential_generation,lifecycle_generation,link_generation,version,revision
      FROM passes WHERE id = ?`,
      [pass.id],
    );
    if (!snapshot) throw new Error('Missing source generation');
    await run(kit.env.DB, 'UPDATE passes SET link_generation = link_generation + 1 WHERE id = ?', [
      pass.id,
    ]);
    await expect(
      run(
        kit.env.DB,
        `INSERT INTO pass_transfer_asset_uploads
      (r2_key,pass_id,credential_generation,lifecycle_generation,link_generation,pass_version,pass_revision,created_at)
      VALUES (?,?,?,?,?,?,?,?)`,
        [
          `pass-assets/${pass.id}/logo.png/stale.png`,
          pass.id,
          snapshot.credential_generation,
          snapshot.lifecycle_generation,
          snapshot.link_generation,
          snapshot.version,
          snapshot.revision,
          kit.clock.now(),
        ],
      ),
    ).rejects.toThrow('image upload key unavailable');
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toEqual({ r2_key: live });
  }, 120_000);

  it('retires both a crashed staged replacement and a pre-PUT reservation on transfer', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const old = `pass-assets/${pass.id}/logo.png/prior.png`;
    const staged = `pass-assets/${pass.id}/logo.png/staged.png`;
    const late = `member-photos/${pass.orgId}/${pass.id}/pending.png`;
    await kit.env.BUCKET.put(old, ICON_PNG);
    await asset(kit, pass.id, old);
    await reserve(kit, pass.id, staged);
    await kit.env.BUCKET.put(staged, ICON_PNG);
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = ?', [
      staged,
      pass.id,
      'logo.png',
    ]);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE r2_key = ?', [
        staged,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
        [pass.id, old],
      ),
    ).not.toBeNull();
    await reserve(kit, pass.id, late);
    const transfer = await begin(kit, pass.id);
    expect(transfer.state).toBe('completed');
    expect(
      new Set(
        (
          await all<{ r2_key: string }>(
            kit.env.DB,
            'SELECT r2_key FROM pass_transfer_asset_gc WHERE transfer_id = ?',
            [transfer.transferId],
          )
        ).map((r) => r.r2_key),
      ),
    ).toEqual(new Set([old, staged, late]));
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_candidates WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    for (const key of [old, staged, late]) await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(old)).toBeNull();
    expect(await kit.env.BUCKET.head(staged)).toBeNull();
    // An interrupted PUT can complete after both transfer and an apparently successful sweep.
    await kit.env.BUCKET.put(late, ICON_PNG);
    await expect(photo(kit, pass.id, pass.orgId, late)).rejects.toThrow('retired pass asset key');
    kit.clock.advance(TRANSFER_ASSET_GC_RECHECK_MS);
    await sweepOneTransferAssetGc(jobCtxOf(kit), late);
    expect(await kit.env.BUCKET.head(late)).toBeNull();
  }, 120_000);

  it('reclaims a crashed upload reservation and keeps its late PUT permanently unreferenceable', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/logo.png/abandoned.png`;
    await reserve(kit, pass.id, key);
    await kit.env.BUCKET.put(key, ICON_PNG);
    kit.clock.advance(TRANSFER_ASSET_UPLOAD_LEASE_MS + 1);
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE r2_key = ?', [key]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
    ).not.toBeNull();
    expect(await kit.env.BUCKET.head(key)).toBeNull();
    await kit.env.BUCKET.put(key, ICON_PNG);
    await expect(asset(kit, pass.id, key)).rejects.toThrow('retired pass asset key');
    kit.clock.advance(TRANSFER_ASSET_GC_RECHECK_MS);
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  }, 120_000);

  it('settles a tombstone after a bounded number of re-checks and keeps it as the key guard', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/logo.png/settling.png`;
    await reserve(kit, pass.id, key);
    kit.clock.advance(TRANSFER_ASSET_UPLOAD_LEASE_MS + 1);
    await sweepTransferAssetGc(jobCtxOf(kit));
    const state = () =>
      first<{ rechecks: number; settled_at: number | null }>(
        kit.env.DB,
        'SELECT rechecks, settled_at FROM pass_transfer_asset_gc WHERE r2_key = ?',
        [key],
      );
    // The key is deleted once when it is retired; each later day re-checks it, a bounded number of times.
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    let sweeps = 0;
    while ((await state())?.settled_at === null && sweeps <= TRANSFER_ASSET_GC_MAX_RECHECKS) {
      await kit.env.BUCKET.put(key, ICON_PNG);
      kit.clock.advance(TRANSFER_ASSET_GC_RECHECK_MS);
      await sweepOneTransferAssetGc(jobCtxOf(kit), key);
      expect(await kit.env.BUCKET.head(key)).toBeNull();
      sweeps++;
    }
    expect((await state())?.settled_at).not.toBeNull();
    expect((await state())?.rechecks).toBe(TRANSFER_ASSET_GC_MAX_RECHECKS);
    // Settled: the sweep no longer visits it, but the row still refuses the key to any writer.
    await kit.env.BUCKET.put(key, ICON_PNG);
    kit.clock.advance(TRANSFER_ASSET_GC_RECHECK_MS);
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    await expect(asset(kit, pass.id, key)).rejects.toThrow('retired pass asset key');
  }, 120_000);

  it('does not let one completed operation release a sibling rollback hold for the same key', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const key = `pass-assets/${pass.id}/shared.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, pass.id, key, 'logo.png');
    await asset(kit, pass.id, key, 'icon.png');
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'logo.png'",
      [`${key}-logo`, pass.id],
    );
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'icon.png'",
      [`${key}-icon`, pass.id],
    );
    const holds = await all<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ? ORDER BY id',
      [pass.id, key],
    );
    const firstHold = holds[0];
    const secondHold = holds[1];
    if (!firstHold || !secondHold) throw new Error('Missing independent rollback holds');
    expect(
      await retireUnusedPassAssetKey(kit.env.DB, {
        key,
        now: kit.clock.now(),
        passId: pass.id,
        candidateId: firstHold.id,
      }),
    ).toBe(true);
    expect(
      await retireUnusedPassAssetKey(kit.env.DB, {
        key,
        now: kit.clock.now(),
        passId: pass.id,
        candidateId: firstHold.id,
      }),
    ).toBe(false);
    expect(
      await first(kit.env.DB, 'SELECT id FROM pass_transfer_asset_candidates WHERE id = ?', [
        secondHold.id,
      ]),
    ).toEqual(secondHold);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
    ).not.toBeNull();
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    await retireUnusedPassAssetKey(kit.env.DB, {
      key,
      now: kit.clock.now(),
      passId: pass.id,
      candidateId: secondHold.id,
    });
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
  }, 120_000);

  it('allows the original pass to roll back a shared retired key only while its hold exists', async () => {
    const kit = await setupKit();
    const transferred = await kit.pass();
    const other = await kit.pass();
    const key = `pass-assets/${transferred.id}/logo.png/shared-rollback.png`;
    const next = `pass-assets/${other.id}/logo.png/replacement.png`;
    await kit.env.BUCKET.put(key, ICON_PNG);
    await kit.env.BUCKET.put(next, ICON_PNG);
    await asset(kit, transferred.id, key);
    await asset(kit, other.id, key);
    expect((await begin(kit, transferred.id)).state).toBe('completed');
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = ?', [
      next,
      other.id,
      'logo.png',
    ]);
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).not.toBeNull();
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = ?', [
      key,
      other.id,
      'logo.png',
    ]);
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [other.id]),
    ).toEqual({ r2_key: key });
    await run(kit.env.DB, 'DELETE FROM pass_assets WHERE pass_id = ?', [other.id]);
    const holds = await all<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [other.id, key],
    );
    for (const hold of holds)
      await retireUnusedPassAssetKey(kit.env.DB, {
        key,
        now: kit.clock.now(),
        passId: other.id,
        candidateId: hold.id,
      });
    await sweepOneTransferAssetGc(jobCtxOf(kit), key);
    expect(await kit.env.BUCKET.head(key)).toBeNull();
    await expect(asset(kit, other.id, key)).rejects.toThrow('retired pass asset key');
  }, 120_000);

  it('increments the image epoch on direct A to B to A mutations', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const a = `pass-assets/${pass.id}/logo.png/a.png`;
    const b = `pass-assets/${pass.id}/logo.png/b.png`;
    await asset(kit, pass.id, a);
    const before = await first<{ image_generation: number }>(
      kit.env.DB,
      'SELECT image_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    if (!before) throw new Error('Missing pass epoch');
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [b, pass.id]);
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [a, pass.id]);
    expect(
      await first(kit.env.DB, 'SELECT image_generation FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ image_generation: before.image_generation + 2 });
  }, 120_000);
});

describe('transfer image epoch and cascade fences', () => {
  it('rejects START after the exact same image rows undergo A to B to A', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const a = `pass-assets/${pass.id}/logo.png/start-a.png`;
    const b = `pass-assets/${pass.id}/logo.png/start-b.png`;
    await kit.env.BUCKET.put(a, ICON_PNG);
    await asset(kit, pass.id, a);
    const snapshot = await first(kit.env.DB, 'SELECT * FROM pass_assets WHERE pass_id = ?', [
      pass.id,
    ]);
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing source pass');
    const seam = interveneAtD1(
      kit.env.DB,
      { method: 'batch', sql: /INSERT INTO pass_credential_transfers\b/, when: 'before' },
      async () => {
        await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [b, pass.id]);
        await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [a, pass.id]);
      },
    );
    const raced = { ...jobCtxOf(kit), env: { ...kit.env, DB: seam.db } };
    await expect(
      startCredentialTransfer(raced, system, pass.id, target, null, {
        kind: 'tenant-holder',
        expected,
      }),
    ).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(seam.hits()).toBe(1);
    expect(
      await first(kit.env.DB, 'SELECT * FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toEqual(snapshot);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_credential_transfers WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key IN (?,?)', [a, b]),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(a)).not.toBeNull();
  }, 120_000);

  it('rejects FINISH after the exact same image rows undergo A to B to A', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const a = `pass-assets/${pass.id}/logo.png/finish-a.png`;
    const b = `pass-assets/${pass.id}/logo.png/finish-b.png`;
    await kit.env.BUCKET.put(a, ICON_PNG);
    await asset(kit, pass.id, a);
    const snapshot = await first(kit.env.DB, 'SELECT * FROM pass_assets WHERE pass_id = ?', [
      pass.id,
    ]);
    const entered = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`passes/${pass.id}/`)) {
        entered.resolve();
        await gate.promise;
      }
      return original(key, bytes, options);
    });
    try {
      const work = begin(kit, pass.id);
      await entered.promise;
      await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [b, pass.id]);
      await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [a, pass.id]);
      gate.resolve();
      const pending = await work;
      expect(pending.state).toBe('pending');
      expect(
        await first(kit.env.DB, 'SELECT * FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toEqual(snapshot);
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key IN (?,?)', [
          a,
          b,
        ]),
      ).toBeNull();
      expect(await kit.env.BUCKET.head(a)).not.toBeNull();
      expect((await finishCredentialTransfer(jobCtxOf(kit), pending.transferId)).state).toBe(
        'completed',
      );
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);

  it('physically deletes a pass and cascades its image rows without aborting or resurrecting it', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const assetKey = `pass-assets/${pass.id}/logo.png/cascade.png`;
    const photoKey = `member-photos/${pass.orgId}/${pass.id}/cascade.png`;
    await kit.env.BUCKET.put(assetKey, ICON_PNG);
    await kit.env.BUCKET.put(photoKey, ICON_PNG);
    await asset(kit, pass.id, assetKey);
    await photo(kit, pass.id, pass.orgId, photoKey);
    await run(kit.env.DB, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await first(kit.env.DB, 'SELECT 1 FROM passes WHERE id = ?', [pass.id])).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      new Set(
        (
          await all<{ r2_key: string }>(
            kit.env.DB,
            'SELECT r2_key FROM pass_transfer_asset_gc WHERE r2_key IN (?,?)',
            [assetKey, photoKey],
          )
        ).map((r) => r.r2_key),
      ),
    ).toEqual(new Set([assetKey, photoKey]));
    await sweepOneTransferAssetGc(jobCtxOf(kit), assetKey);
    await sweepOneTransferAssetGc(jobCtxOf(kit), photoKey);
    expect(await kit.env.BUCKET.head(assetKey)).toBeNull();
    expect(await kit.env.BUCKET.head(photoKey)).toBeNull();
    expect(await first(kit.env.DB, 'SELECT 1 FROM passes WHERE id = ?', [pass.id])).toBeNull();
  }, 120_000);
});

describe('crashed image-stage recovery', () => {
  it('restores an abandoned staged asset and durably deletes the displaced upload', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const old = `pass-assets/${pass.id}/logo.png/recover-old.png`;
    const staged = `pass-assets/${pass.id}/logo.png/recover-new.png`;
    await kit.env.BUCKET.put(old, ICON_PNG);
    await kit.env.BUCKET.put(staged, ICON_PNG);
    await asset(kit, pass.id, old);
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [staged, pass.id]);
    const before = await first<{ image_generation: number; link_generation: number }>(
      kit.env.DB,
      'SELECT image_generation,link_generation FROM passes WHERE id = ?',
      [pass.id],
    );
    const hold = await first<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [pass.id, old],
    );
    if (!before || !hold) throw new Error('Missing staged image snapshot');
    kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toEqual({ r2_key: old });
    expect(
      await first(kit.env.DB, 'SELECT image_generation,link_generation FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual({
      image_generation: before.image_generation + 1,
      link_generation: before.link_generation + 1,
    });
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_candidates WHERE id = ?', [
        hold.id,
      ]),
    ).toBeNull();
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_transfer_asset_recoveries WHERE candidate_id = ?',
        [hold.id],
      ),
    ).toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [staged]),
    ).not.toBeNull();
    expect(await kit.env.BUCKET.head(old)).not.toBeNull();
    expect(await kit.env.BUCKET.head(staged)).toBeNull();
  }, 120_000);

  it('restores a deleted image and an unacknowledged scanner-only photo', async () => {
    const kit = await setupKit();
    const assetPass = await kit.pass();
    const photoPass = await kit.pass();
    const deleted = `pass-assets/${assetPass.id}/logo.png/deleted.png`;
    const oldPhoto = `member-photos/${photoPass.orgId}/${photoPass.id}/old.png`;
    const nextPhoto = `member-photos/${photoPass.orgId}/${photoPass.id}/new.png`;
    for (const key of [deleted, oldPhoto, nextPhoto]) await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, assetPass.id, deleted);
    await photo(kit, photoPass.id, photoPass.orgId, oldPhoto);
    await run(kit.env.DB, 'DELETE FROM pass_assets WHERE pass_id = ?', [assetPass.id]);
    await run(
      kit.env.DB,
      "UPDATE member_photos SET r2_key = ?, version = 'new' WHERE pass_id = ?",
      [nextPhoto, photoPass.id],
    );
    kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [assetPass.id]),
    ).toEqual({ r2_key: deleted });
    expect(
      await first(kit.env.DB, 'SELECT r2_key,version FROM member_photos WHERE pass_id = ?', [
        photoPass.id,
      ]),
    ).toEqual({ r2_key: oldPhoto, version: 'original' });
    expect(await kit.env.BUCKET.head(deleted)).not.toBeNull();
    expect(await kit.env.BUCKET.head(oldPhoto)).not.toBeNull();
    expect(await kit.env.BUCKET.head(nextPhoto)).toBeNull();
  }, 120_000);

  it('recovers multi-slot stages in reverse order without deleting a still-needed rollback key', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const oldLogo = `pass-assets/${pass.id}/logo.png/old.png`;
    const newLogo = `pass-assets/${pass.id}/logo.png/new.png`;
    const oldIcon = `pass-assets/${pass.id}/icon.png/old.png`;
    const newIcon = `pass-assets/${pass.id}/icon.png/new.png`;
    for (const key of [oldLogo, newLogo, oldIcon, newIcon]) await kit.env.BUCKET.put(key, ICON_PNG);
    await asset(kit, pass.id, oldLogo, 'logo.png');
    await asset(kit, pass.id, oldIcon, 'icon.png');
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'logo.png'",
      [newLogo, pass.id],
    );
    await run(
      kit.env.DB,
      "UPDATE pass_assets SET r2_key = ? WHERE pass_id = ? AND name = 'icon.png'",
      [newIcon, pass.id],
    );
    kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(
        kit.env.DB,
        "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'icon.png'",
        [pass.id],
      ),
    ).toEqual({ r2_key: oldIcon });
    expect(
      await first(
        kit.env.DB,
        "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'logo.png'",
        [pass.id],
      ),
    ).toEqual({ r2_key: newLogo });
    expect(await kit.env.BUCKET.head(oldLogo)).not.toBeNull();
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(
        kit.env.DB,
        "SELECT r2_key FROM pass_assets WHERE pass_id = ? AND name = 'logo.png'",
        [pass.id],
      ),
    ).toEqual({ r2_key: oldLogo });
    expect(await kit.env.BUCKET.head(newLogo)).toBeNull();
    expect(await kit.env.BUCKET.head(newIcon)).toBeNull();
  }, 120_000);

  it('does not restore a prior key after a newer pass version committed', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const old = `pass-assets/${pass.id}/logo.png/published-old.png`;
    const next = `pass-assets/${pass.id}/logo.png/published-next.png`;
    await kit.env.BUCKET.put(old, ICON_PNG);
    await kit.env.BUCKET.put(next, ICON_PNG);
    await asset(kit, pass.id, old);
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [next, pass.id]);
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toEqual({ r2_key: next });
    expect(await kit.env.BUCKET.head(old)).toBeNull();
    expect(await kit.env.BUCKET.head(next)).not.toBeNull();
  }, 120_000);

  it('does not release or restore image holds while holder transfer is pending', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const old = `pass-assets/${pass.id}/logo.png/pending-old.png`;
    const next = `pass-assets/${pass.id}/logo.png/pending-next.png`;
    const upload = `member-photos/${pass.orgId}/${pass.id}/pending-upload.png`;
    await kit.env.BUCKET.put(old, ICON_PNG);
    await kit.env.BUCKET.put(next, ICON_PNG);
    await asset(kit, pass.id, old);
    await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [next, pass.id]);
    const hold = await first<{ id: number }>(
      kit.env.DB,
      'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
      [pass.id, old],
    );
    if (!hold) throw new Error('Missing pending rollback hold');
    await run(
      kit.env.DB,
      `INSERT INTO pass_transfer_asset_uploads
      (r2_key,pass_id,credential_generation,lifecycle_generation,link_generation,pass_version,pass_revision,created_at)
      SELECT ?,id,credential_generation,lifecycle_generation,link_generation,version,revision,?
      FROM passes WHERE id = ?`,
      [upload, kit.clock.now(), pass.id],
    );
    await kit.env.BUCKET.put(upload, ICON_PNG);
    const entered = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`passes/${pass.id}/`)) {
        entered.resolve();
        await gate.promise;
      }
      return original(key, bytes, options);
    });
    try {
      const work = begin(kit, pass.id);
      await entered.promise;
      kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
      expect(
        await retireUnusedPassAssetKey(kit.env.DB, {
          key: old,
          now: kit.clock.now(),
          passId: pass.id,
          candidateId: hold.id,
        }),
      ).toBe(false);
      await retireUnusedPassAssetKey(kit.env.DB, {
        key: upload,
        now: kit.clock.now(),
        passId: pass.id,
      });
      await sweepTransferAssetGc(jobCtxOf(kit));
      expect(
        await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toEqual({ r2_key: next });
      expect(
        await first(
          kit.env.DB,
          'SELECT 1 FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
          [pass.id, old],
        ),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_uploads WHERE r2_key = ?', [
          upload,
        ]),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key IN (?,?)', [
          old,
          upload,
        ]),
      ).toBeNull();
      expect(await kit.env.BUCKET.head(upload)).not.toBeNull();
      expect(await kit.env.BUCKET.head(old)).not.toBeNull();
      gate.resolve();
      expect((await work).state).toBe('completed');
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);
});

it('rechecks newest operation ownership when a candidate races recovery', async () => {
  const kit = await setupKit();
  const pass = await kit.pass();
  const a = `pass-assets/${pass.id}/logo.png/recovery-race-a.png`;
  const b = `pass-assets/${pass.id}/logo.png/recovery-race-b.png`;
  const c = `pass-assets/${pass.id}/logo.png/recovery-race-c.png`;
  for (const key of [a, b, c]) await kit.env.BUCKET.put(key, ICON_PNG);
  await asset(kit, pass.id, a);
  await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [b, pass.id]);
  const stale = await first<{ id: number; created_at: number }>(
    kit.env.DB,
    'SELECT id,created_at FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
    [pass.id, a],
  );
  if (!stale) throw new Error('Missing captured operation');
  kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
  await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [c, pass.id]);
  await recoverExpiredPassAssetCandidate(kit.env.DB, {
    id: stale.id,
    createdAt: stale.created_at,
    cutoff: kit.clock.now() - TRANSFER_ASSET_STAGE_LEASE_MS,
    now: kit.clock.now(),
  });
  expect(
    await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
  ).toEqual({ r2_key: c });
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_candidates WHERE id = ?', [
      stale.id,
    ]),
  ).not.toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [a]),
  ).toBeNull();
  expect(await kit.env.BUCKET.head(a)).not.toBeNull();
}, 120_000);

it('keeps a shared template key queued until its last independent reference disappears', async () => {
  const kit = await setupKit();
  const pass = await kit.pass();
  const old = `pass-assets/${pass.id}/logo.png/shared-template-old.png`;
  const next = `pass-assets/${pass.id}/logo.png/shared-template-next.png`;
  await kit.env.BUCKET.put(old, ICON_PNG);
  await kit.env.BUCKET.put(next, ICON_PNG);
  await asset(kit, pass.id, old);
  await run(
    kit.env.DB,
    `INSERT INTO template_versions
    (template_id,version,manifest,pass_json,assets,report,created_by,created_at)
    SELECT template_id,version || '-cleanup-shared',manifest,pass_json,?,report,created_by,created_at
    FROM template_versions WHERE template_id = ? AND version = ?`,
    [JSON.stringify([{ source: { kind: 'r2', key: old } }]), kit.template.id, kit.template.version],
  );
  await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [next, pass.id]);
  const hold = await first<{ id: number }>(
    kit.env.DB,
    'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
    [pass.id, old],
  );
  if (!hold) throw new Error('Missing displaced-key hold');
  expect(
    await retireUnusedPassAssetKey(kit.env.DB, {
      key: old,
      now: kit.clock.now(),
      passId: pass.id,
      candidateId: hold.id,
    }),
  ).toBe(true);
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [old]),
  ).not.toBeNull();
  await sweepOneTransferAssetGc(jobCtxOf(kit), old);
  expect(await kit.env.BUCKET.head(old)).not.toBeNull();
  await run(kit.env.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
    kit.template.id,
    `${kit.template.version}-cleanup-shared`,
  ]);
  await sweepOneTransferAssetGc(jobCtxOf(kit), old);
  expect(await kit.env.BUCKET.head(old)).toBeNull();
}, 120_000);

it('does not retire the live key for a successful metadata-only photo update', async () => {
  const kit = await setupKit();
  const pass = await kit.pass();
  const key = `member-photos/${pass.orgId}/${pass.id}/metadata.png`;
  await kit.env.BUCKET.put(key, ICON_PNG);
  await photo(kit, pass.id, pass.orgId, key);
  await run(kit.env.DB, "UPDATE member_photos SET version = 'updated' WHERE pass_id = ?", [
    pass.id,
  ]);
  const hold = await first<{ id: number }>(
    kit.env.DB,
    'SELECT id FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
    [pass.id, key],
  );
  if (!hold) throw new Error('Missing metadata update hold');
  expect(
    await retireUnusedPassAssetKey(kit.env.DB, {
      key,
      now: kit.clock.now(),
      passId: pass.id,
      candidateId: hold.id,
    }),
  ).toBe(true);
  expect(
    await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_gc WHERE r2_key = ?', [key]),
  ).toBeNull();
  expect(
    await first(kit.env.DB, 'SELECT version,r2_key FROM member_photos WHERE pass_id = ?', [
      pass.id,
    ]),
  ).toEqual({ version: 'updated', r2_key: key });
  expect(await kit.env.BUCKET.head(key)).not.toBeNull();
}, 120_000);

it('rolls back recovery if displaced-key retirement cannot commit', async () => {
  const kit = await setupKit();
  const pass = await kit.pass();
  const old = `pass-assets/${pass.id}/logo.png/rollback-recovery-old.png`;
  const next = `pass-assets/${pass.id}/logo.png/rollback-recovery-next.png`;
  await kit.env.BUCKET.put(old, ICON_PNG);
  await kit.env.BUCKET.put(next, ICON_PNG);
  await asset(kit, pass.id, old);
  await run(kit.env.DB, 'UPDATE pass_assets SET r2_key = ? WHERE pass_id = ?', [next, pass.id]);
  const before = await first(
    kit.env.DB,
    'SELECT image_generation,link_generation FROM passes WHERE id = ?',
    [pass.id],
  );
  await run(
    kit.env.DB,
    `CREATE TRIGGER fail_image_recovery BEFORE INSERT ON pass_transfer_asset_gc
    WHEN NEW.r2_key = '${next}' BEGIN SELECT RAISE(ABORT, 'forced recovery rollback'); END`,
  );
  kit.clock.advance(TRANSFER_ASSET_STAGE_LEASE_MS + 2000);
  try {
    await sweepTransferAssetGc(jobCtxOf(kit));
    expect(
      await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
    ).toEqual({ r2_key: next });
    expect(
      await first(kit.env.DB, 'SELECT image_generation,link_generation FROM passes WHERE id = ?', [
        pass.id,
      ]),
    ).toEqual(before);
    expect(
      await first(
        kit.env.DB,
        'SELECT 1 FROM pass_transfer_asset_candidates WHERE pass_id = ? AND r2_key = ?',
        [pass.id, old],
      ),
    ).not.toBeNull();
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_transfer_asset_recoveries WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    expect(await kit.env.BUCKET.head(old)).not.toBeNull();
    expect(await kit.env.BUCKET.head(next)).not.toBeNull();
  } finally {
    await run(kit.env.DB, 'DROP TRIGGER fail_image_recovery');
  }
  await sweepTransferAssetGc(jobCtxOf(kit));
  expect(
    await first(kit.env.DB, 'SELECT r2_key FROM pass_assets WHERE pass_id = ?', [pass.id]),
  ).toEqual({ r2_key: old });
  expect(await kit.env.BUCKET.head(next)).toBeNull();
}, 120_000);
