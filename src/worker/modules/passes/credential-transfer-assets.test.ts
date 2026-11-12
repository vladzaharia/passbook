import { describe, expect, it, vi } from 'vitest';
import { sha1Hex } from '../../../passkit/sign/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { getHolderPass } from '../holders/repo.ts';
import { finishCredentialTransfer, startCredentialTransfer } from './credential-transfer.ts';
import { expectValidZip, ICON_PNG, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

// The Worker targets ES2023; its test runtime provides Promise.withResolvers.
const deferred = Promise as PromiseConstructor & {
  withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
};

describe('transfer asset retirement', () => {
  it('keeps old assets on a lost final CAS and excludes them from the successful target package', async () => {
    const kit = await setupKit();
    const pass = await kit.pass();
    const assetKey = `pass-assets/${pass.id}/logo.png/old.png`;
    const photoKey = `member-photos/${pass.orgId}/${pass.id}/old.png`;
    const hash = await sha1Hex(ICON_PNG);
    await kit.env.BUCKET.put(assetKey, ICON_PNG);
    await kit.env.BUCKET.put(photoKey, ICON_PNG);
    await run(
      kit.env.DB,
      `INSERT INTO pass_assets
      (pass_id,name,r2_key,sha1,size,width,height,crc32,created_at) VALUES (?,'logo.png',?,?,?,38,38,0,?)`,
      [pass.id, assetKey, hash, ICON_PNG.length, kit.clock.now()],
    );
    await run(
      kit.env.DB,
      `INSERT INTO member_photos
      (pass_id,org_id,r2_key,sha1,size,crc32,include_in_pass,version,updated_at) VALUES (?,?,?,?,?,0,1,'old',?)`,
      [pass.id, pass.orgId, photoKey, hash, ICON_PNG.length, kit.clock.now()],
    );
    // Assets and photos move row_version, so the source is read after they exist.
    const expected = await getHolderPass(kit.env.DB, pass.id, null);
    if (!expected) throw new Error('Missing holder source');
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
      const work = startCredentialTransfer(
        jobCtxOf(kit),
        { type: 'system', id: null },
        pass.id,
        { holderEmail: 'next@example.test', ownerUserId: null },
        null,
        { kind: 'tenant-holder', expected },
      );
      // A start that fails before the upload must fail the test, not wait for a gate that never opens.
      await Promise.race([entered.promise, work]);
      const transfer = await first<{ id: string }>(
        kit.env.DB,
        "SELECT id FROM pass_credential_transfers WHERE pass_id = ? AND state = 'pending'",
        [pass.id],
      );
      if (!transfer) throw new Error('Missing pending transfer');
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [pass.id]),
      ).not.toBeNull();
      // Any bump-set column moves row_version; an org timestamp is no longer authority.
      await run(kit.env.DB, "UPDATE passes SET external_id = 'raced' WHERE id = ?", [pass.id]);
      gate.resolve();
      expect(await work).toEqual({ transferId: transfer.id, state: 'pending' });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).not.toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [pass.id]),
      ).not.toBeNull();
      expect(await kit.env.BUCKET.get(assetKey)).not.toBeNull();
      expect(await kit.env.BUCKET.get(photoKey)).not.toBeNull();
      expect(await finishCredentialTransfer(jobCtxOf(kit), transfer.id)).toEqual({
        transferId: transfer.id,
        state: 'completed',
      });
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      expect(
        await first(kit.env.DB, 'SELECT 1 FROM member_photos WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
      const after = await getPass(kit.env.DB, pass.id);
      const artifact = after && (await kit.env.BUCKET.get(after.objectKey));
      if (!artifact) throw new Error('Missing transferred artifact');
      const names = expectValidZip(new Uint8Array(await artifact.arrayBuffer()));
      expect(names).not.toContain('logo.png');
      expect(names).not.toContain('thumbnail@3x.png');
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  }, 120_000);
});
