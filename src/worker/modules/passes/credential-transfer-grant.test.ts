import { describe, expect, it, vi } from 'vitest';
import { all, first } from '../../platform/db.ts';
import { interveneAtD1 } from '../apple/credential-transfer-test-fixtures.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { approveAppleRelease } from './apple-release-test-fixtures.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';

const system = { type: 'system', id: null } as const;
const target = { holderEmail: 'next@example.test', ownerUserId: null } as const;
const GRANT_INSERT = /INSERT INTO authority_grants\b/;

async function startOn(kit: Kit, passId: string, db: D1Database = kit.env.DB) {
  const expected = await getHolderPass(kit.env.DB, passId, null);
  if (!expected) throw new Error('Missing holder source');
  const ctx = { ...jobCtxOf(kit), env: { ...kit.env, DB: db } };
  return startCredentialTransfer(ctx, system, passId, target, null, {
    kind: 'tenant-holder',
    expected,
  });
}
const transfers = (kit: Kit, passId: string) =>
  all<{ state: string }>(
    kit.env.DB,
    'SELECT state FROM pass_credential_transfers WHERE pass_id = ?',
    [passId],
  );

describe('credential transfer grants (authority-epochs.md 8.5 test 32)', () => {
  it('refuses a start when a publish lands between read and commit (stale)', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const seam = interveneAtD1(
      kit.env.DB,
      { method: 'batch', sql: GRANT_INSERT, when: 'before' },
      async () => {
        await publishPass(jobCtxOf(kit), {
          passId: pass.id,
          cause: 'user_refresh',
          actor: system,
          force: true,
        });
      },
    );
    await expect(startOn(kit, pass.id, seam.db)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(seam.hits()).toBe(1);
    expect(await transfers(kit, pass.id)).toEqual([]);
  });

  it('refuses a start when another transfer lands between read and commit (lineage)', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const seam = interveneAtD1(
      kit.env.DB,
      { method: 'batch', sql: GRANT_INSERT, when: 'before' },
      async () => {
        await startOn(kit, pass.id);
      },
    );
    await expect(startOn(kit, pass.id, seam.db)).rejects.toMatchObject({ code: 'PASS_CONFLICT' });
    expect(await transfers(kit, pass.id)).toEqual([{ state: 'completed' }]);
  });

  it('leaves a transfer pending when a release is approved mid-finish, and the sweep rebuilds', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const arrived = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`passes/${pass.id}/`)) {
        arrived.resolve();
        await gate.promise;
      }
      return original(key, bytes, options);
    });
    try {
      const work = startOn(kit, pass.id);
      await arrived.promise;
      const release = await approveAppleRelease(kit);
      gate.resolve();
      const first_ = await work;
      expect(first_.state).toBe('pending');
      await expect(finishCredentialTransfer(jobCtxOf(kit), first_.transferId)).resolves.toEqual({
        transferId: first_.transferId,
        state: 'completed',
      });
      expect(await getPass(kit.env.DB, pass.id)).toMatchObject({
        releaseId: release.id,
        holderEmail: target.holderEmail,
      });
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 60_000);

  it('runs start and finish each as one D1 batch after their reads', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const batches: number[] = [];
    const counted = new Proxy(kit.env.DB, {
      get(db, property) {
        if (property === 'batch')
          return (statements: D1PreparedStatement[]) => {
            batches.push(statements.length);
            return db.batch(statements);
          };
        const value = Reflect.get(db, property, db);
        return typeof value === 'function' ? value.bind(db) : value;
      },
    });
    const result = await startOn(kit, pass.id, counted);
    expect(result.state).toBe('completed');
    const grantBatches = batches.filter((n) => n > 3);
    expect(grantBatches).toHaveLength(2);
    expect(await first(kit.env.DB, 'SELECT 1 FROM authority_grants LIMIT 1')).toBeNull();
  });
});
