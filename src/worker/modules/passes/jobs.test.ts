import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { getVersionDetail } from './detail.ts';
import { dailyPasses, handlePassPurgeVersions, handlePassReissue } from './jobs.ts';
import { getPass } from './repo.ts';
import { updatePass } from './service.ts';
import { type Kit, setupKit } from './test-kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
});

const actor = { type: 'system', id: null } as const;
const DAY = 86_400_000;

async function passWithVersions(count: number) {
  const pass = await kit.pass({ memberName: 'v1' });
  for (let i = 2; i <= count; i++)
    await updatePass(kit.ctx, actor, pass.id, { input: { memberName: `v${i}` } }, { scope: null });
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
    const pass = await passWithVersions(5);
    const short = await passWithVersions(2);
    await dailyPasses(kit.ctx);
    expect((await rows(pass.id)).filter((r) => r.purged_at === null).map((r) => r.version)).toEqual(
      [4, 5],
    );
    expect((await rows(short.id)).every((r) => r.purged_at === null)).toBe(true);
    await run(kit.env.DB, "DELETE FROM settings WHERE key = 'retention.passVersionsKeep'");
  });

  it('purges a single pass on demand and is idempotent', async () => {
    const pass = await passWithVersions(7);
    await handlePassPurgeVersions({ kind: 'pass.purge-versions', passId: pass.id }, kit.ctx);
    await handlePassPurgeVersions({ kind: 'pass.purge-versions', passId: pass.id }, kit.ctx);
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

describe('pass.reissue', () => {
  it('re-signs with force for a resign and publishes with that cause', async () => {
    const pass = await kit.pass();
    await handlePassReissue(
      {
        kind: 'pass.reissue',
        passId: pass.id,
        templateVersion: pass.templateVersion,
        cause: 'resign',
      },
      kit.ctx,
    );
    const after = await getPass(kit.env.DB, pass.id);
    expect(after?.version).toBe(2);
    const cause = await first<{ cause: string }>(
      kit.env.DB,
      'SELECT cause FROM pass_versions WHERE pass_id = ? AND version = 2',
      [pass.id],
    );
    expect(cause?.cause).toBe('resign');
  });

  it('skips a pass that no longer exists instead of retrying forever', async () => {
    await handlePassReissue(
      { kind: 'pass.reissue', passId: 'missing', templateVersion: 'v1', cause: 'template_upgrade' },
      kit.ctx,
    );
  });
});
