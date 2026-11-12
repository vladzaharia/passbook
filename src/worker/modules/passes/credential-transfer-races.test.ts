import { describe, expect, it, vi } from 'vitest';
import { first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

// The Worker targets ES2023; its test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

describe('credential transfer races', () => {
  it('keeps only the winning object when two finishers race', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder source');
    const firstUpload = deferred.withResolvers<void>();
    const bothUploads = deferred.withResolvers<void>();
    const gate = deferred.withResolvers<void>();
    const original = kit.env.BUCKET.put.bind(kit.env.BUCKET);
    let hits = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'put').mockImplementation(async (key, bytes, options) => {
      if (key.startsWith(`passes/${pass.id}/`)) {
        if (++hits === 1) firstUpload.resolve();
        if (hits === 2) bothUploads.resolve();
        await gate.promise;
      }
      return original(key, bytes, options);
    });
    try {
      const start = startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: 'next@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      );
      await firstUpload.promise;
      const transfer = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!transfer) throw new Error('Missing pending reservation');
      const second = finishCredentialTransfer(jobCtxOf(kit), transfer.id);
      await bothUploads.promise;
      gate.resolve();
      const [a, b] = await Promise.all([start, second]);
      expect(a).toEqual({ transferId: transfer.id, state: 'completed' });
      expect(b).toEqual(a);
      const objects = (await kit.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects;
      expect(objects).toHaveLength(2);
      const changed = await getPass(kit.env.DB, pass.id);
      expect(objects.map((object) => object.key)).toContain(changed?.objectKey);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);
});
