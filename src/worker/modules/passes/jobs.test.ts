import { beforeAll, describe, expect, it, vi } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { all, first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { replaceCallbackKeysetForTest } from '../wallet-providers/callbacks-test-fixtures.ts';
import {
  credentialRefKeysetCommitment,
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from './credential-keyset.ts';
import { diffVersions, getVersionDetail } from './detail.ts';
import { dailyPasses } from './jobs.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import {
  blockedDeletedPasses,
  deletePassRows,
  expiredDeletedPasses,
} from './repo-ops-retention.ts';
import { getPass } from './repo-read-pass.ts';
import { deletePass, updatePass } from './service.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});

const actor = { type: 'system', id: null } as const;
const DAY = 86_400_000;

async function passWithVersions(count: number) {
  const pass = await kit.pass({ memberName: 'v1' });
  for (let i = 2; i <= count; i++)
    await updatePass(
      jobCtxOf(kit),
      actor,
      pass.id,
      { input: { memberName: `v${i}` } },
      { scope: null },
    );
  return pass;
}

const rows = (passId: string) =>
  all<{
    version: number;
    object_key: string | null;
    pass_json: string | null;
    purged_at: number | null;
  }>(
    kit.env.DB,
    'SELECT version, object_key, pass_json, purged_at FROM pass_versions WHERE pass_id = ? ORDER BY version',
    [passId],
  );

describe('version retention', () => {
  it('keeps the current version plus the last three and deletes the rest from R2', async () => {
    const pass = await passWithVersions(8);
    const before = await rows(pass.id);
    const oldKeys = before.filter((r) => r.version <= 4).map((r) => r.object_key ?? '');
    for (const key of oldKeys) expect(await kit.env.BUCKET.head(key)).not.toBeNull();

    await dailyPasses(kit.ctx);

    const after = await rows(pass.id);
    expect(after.filter((r) => r.purged_at === null).map((r) => r.version)).toEqual([5, 6, 7, 8]);
    for (const row of after.filter((r) => r.purged_at !== null)) {
      expect(row.object_key).toBeNull();
      expect(row.pass_json).toBeNull();
    }
    for (const key of oldKeys) expect(await kit.env.BUCKET.head(key)).toBeNull();
    const current = await getPass(kit.env.DB, pass.id);
    expect(await kit.env.BUCKET.head(current?.objectKey ?? '')).not.toBeNull();
    for (const row of after.filter((r) => r.purged_at === null))
      expect(await kit.env.BUCKET.head(row.object_key ?? '')).not.toBeNull();
  });

  it('drops personalization from purged versions and refuses to diff them', async () => {
    const pass = await passWithVersions(8);
    await dailyPasses(kit.ctx);
    const purged = await all<{ personalization: string }>(
      kit.env.DB,
      'SELECT personalization FROM pass_versions WHERE pass_id = ? AND purged_at IS NOT NULL',
      [pass.id],
    );
    expect(purged.length).toBeGreaterThan(0);
    expect(purged.every((r) => r.personalization === '{}')).toBe(true);
    await expect(diffVersions(kit.ctx, pass.id, 1, 8, null)).rejects.toMatchObject({ status: 410 });
  });

  it('answers 410 for a purged version and renders a retained one', async () => {
    const pass = await passWithVersions(6);
    await dailyPasses(kit.ctx);
    await expect(getVersionDetail(kit.ctx, pass.id, 1, null)).rejects.toMatchObject({
      status: 410,
      code: 'VERSION_PURGED',
    });
    const kept = await getVersionDetail(kit.ctx, pass.id, 5, null);
    expect(kept.personalization).toEqual({ memberName: 'v5' });
  });

  it('follows the retention setting and leaves short histories alone', async () => {
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_at) VALUES ('platform', 'retention.passVersionsKeep', '1', 1)",
    );
    clearSettingsCache(kit.env.DB);
    const pass = await passWithVersions(5);
    const short = await passWithVersions(2);
    await dailyPasses(kit.ctx);
    expect((await rows(pass.id)).filter((r) => r.purged_at === null).map((r) => r.version)).toEqual(
      [4, 5],
    );
    expect((await rows(short.id)).every((r) => r.purged_at === null)).toBe(true);
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'retention.passVersionsKeep'");
    clearSettingsCache(kit.env.DB);
  });

  it('purges idempotently', async () => {
    const pass = await passWithVersions(7);
    await dailyPasses(kit.ctx);
    await dailyPasses(kit.ctx);
    expect((await rows(pass.id)).filter((r) => r.purged_at === null)).toHaveLength(4);
  });

  it('drops idempotency keys after seven days', async () => {
    const now = kit.clock.now();
    await run(
      kit.env.DB,
      'INSERT INTO idempotency_keys (org_id, key, request_hash, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
      [kit.org.id, 'old-key', 'h', now - 8 * DAY, kit.org.id, 'new-key', 'h', now - DAY],
    );
    await dailyPasses(kit.ctx);
    expect(
      await first(kit.env.DB, "SELECT 1 FROM idempotency_keys WHERE key = 'old-key'"),
    ).toBeNull();
    expect(
      await first(kit.env.DB, "SELECT 1 FROM idempotency_keys WHERE key = 'new-key'"),
    ).not.toBeNull();
  });
});

describe('deleted-pass purge selection (W1-13)', () => {
  it('skips a blocked pass, keeps selecting later ones with a cursor, and logs what it skipped', async () => {
    const local = await setupKit();
    await ensureCredentialRefKeyset(local.env.DB, local.env);
    const blocked = await local.pass();
    const free = await local.pass();
    await deletePass(jobCtxOf(local), actor, blocked.id, null);
    await deletePass(jobCtxOf(local), actor, free.id, null);
    await stagePendingCredentialTransfer(local.env.DB, blocked.id, {
      id: local.fx.ids.id(),
      token: local.fx.ids.token(),
      now: local.clock.now(),
    });
    local.clock.advance(8 * DAY);
    const before = local.clock.now() - 7 * DAY;
    const selectable = await expiredDeletedPasses(local.env.DB, before, '', 50);
    expect(selectable.map((p) => p.id)).toEqual([free.id]);
    // The cursor moves past what was seen.
    expect(await expiredDeletedPasses(local.env.DB, before, free.id, 50)).toEqual([]);
    expect((await blockedDeletedPasses(local.env.DB, before, 20)).map((p) => p.id)).toEqual([
      blocked.id,
    ]);
    const warn = vi.spyOn(local.ctx.log, 'warn');
    await dailyPasses(local.ctx);
    expect(await getPass(local.env.DB, free.id)).toBeNull();
    expect(
      await first(local.env.DB, 'SELECT id FROM passes WHERE id = ?', [blocked.id]),
    ).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'passes.purge_blocked',
      expect.objectContaining({ code: 'PASS_PURGE_BLOCKED', count: 1, passIds: [blocked.id] }),
    );
  }, 60_000);
});

describe('hard deletion snapshots', () => {
  it('requires the selected Test cutoff and lifecycle generation at the final delete', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const retention = await prepareScanRetentionDelete(kit.env, pass);
    const untouched = { deleted: false, objectKeys: [], deviceIds: [] };
    expect(
      await deletePassRows(kit.env.DB, pass, retention, credentialKeysetCommitment, {
        testBefore: pass.createdAt,
        lifecycleGeneration: 0,
      }),
    ).toEqual(untouched);
    expect(
      await deletePassRows(kit.env.DB, pass, retention, credentialKeysetCommitment, {
        testBefore: pass.createdAt + 1,
        lifecycleGeneration: 1,
      }),
    ).toEqual(untouched);
    expect(await getPass(kit.env.DB, pass.id)).not.toBeNull();
    const removed = await deletePassRows(kit.env.DB, pass, retention, credentialKeysetCommitment, {
      testBefore: pass.createdAt + 1,
      lifecycleGeneration: 0,
    });
    expect(removed.deleted).toBe(true);
    expect(removed.objectKeys).toContain(pass.objectKey);
  }, 60_000);

  it('does not delete after the selected pass revision changes', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const credentialKeysetCommitment = await requireCredentialRefKeyset(kit.env.DB, kit.env);
    const retention = await prepareScanRetentionDelete(kit.env, pass);
    await run(kit.env.DB, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [pass.id]);
    expect(
      await deletePassRows(kit.env.DB, pass, retention, credentialKeysetCommitment, {
        testBefore: pass.createdAt + 1,
        lifecycleGeneration: 0,
      }),
    ).toEqual({ deleted: false, objectKeys: [], deviceIds: [] });
    expect(await getPass(kit.env.DB, pass.id)).not.toBeNull();
  }, 60_000);

  it('rejects absent and malformed commitments before deleting a pass', async () => {
    const pass = await kit.pass({ mode: 'test' });
    const db = kit.env.DB;
    const credentialKeysetCommitment = await requireCredentialRefKeyset(db, kit.env);
    const retention = await prepareScanRetentionDelete(kit.env, pass);
    const guard = { testBefore: pass.createdAt + 1, lifecycleGeneration: pass.lifecycleGeneration };
    const untouched = { deleted: false, objectKeys: [], deviceIds: [] };
    for (const invalid of [undefined, null, '', 'not-a-commitment']) {
      expect(await deletePassRows(db, pass, retention, invalid as string, guard)).toEqual(
        untouched,
      );
      expect(await getPass(db, pass.id)).not.toBeNull();
      expect(await kit.env.BUCKET.head(pass.objectKey)).not.toBeNull();
    }
    expect(
      (await deletePassRows(db, pass, retention, credentialKeysetCommitment, guard)).deleted,
    ).toBe(true);
  }, 60_000);

  it.each(['changed', 'missing'] as const)(
    'fails closed before retention when the keyset is already %s',
    async (change) => {
      const local = await setupKit();
      const db = local.env.DB;
      const pass = await local.pass();
      await local.device(pass, 'preflight-keyset-device', 'device-token');
      await deletePass(jobCtxOf(local), actor, pass.id, null);
      local.clock.advance(8 * DAY);
      const credentialKeysetCommitment = await requireCredentialRefKeyset(db, local.env);
      const replacement = await credentialRefKeysetCommitment({ KEK_V1: btoa('q'.repeat(32)) });
      expect(replacement).not.toBe(credentialKeysetCommitment);
      const beforePass = await first(db, 'SELECT * FROM passes WHERE id = ?', [pass.id]);
      const beforeVersions = await all(
        db,
        'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version',
        [pass.id],
      );
      const objectKeys = (await local.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects
        .map((object) => object.key)
        .sort();
      await replaceCallbackKeysetForTest(db, change === 'changed' ? replacement : null);
      try {
        await expect(dailyPasses(local.ctx)).rejects.toMatchObject({
          code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
        });
        expect(
          await first(db, 'SELECT commitment FROM credential_ref_keyset WHERE id = 1'),
        ).toEqual(change === 'changed' ? { commitment: replacement } : null);
        expect(await first(db, 'SELECT * FROM passes WHERE id = ?', [pass.id])).toEqual(beforePass);
        expect(
          await all(db, 'SELECT * FROM pass_versions WHERE pass_id = ? ORDER BY version', [
            pass.id,
          ]),
        ).toEqual(beforeVersions);
        expect(
          await first(db, 'SELECT 1 FROM registrations WHERE pass_id = ?', [pass.id]),
        ).not.toBeNull();
        expect(
          await first(db, 'SELECT 1 FROM devices WHERE device_id = ? AND identity_id = ?', [
            'preflight-keyset-device',
            pass.identityId,
          ]),
        ).not.toBeNull();
        expect(
          (await local.env.BUCKET.list({ prefix: `passes/${pass.id}/` })).objects
            .map((object) => object.key)
            .sort(),
        ).toEqual(objectKeys);
      } finally {
        await replaceCallbackKeysetForTest(db, credentialKeysetCommitment);
      }
    },
    120_000,
  );
});
