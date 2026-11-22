import { beforeAll, describe, expect, it } from 'vitest';
import { insertLeakedGrant } from '../../../../test/helpers/grant-leak.ts';
import { first, run } from '../../platform/db.ts';
import { importTags } from './import.ts';
import { createKeyset } from './keysets.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { tagRef } from './tag-ref.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const db = () => f.kit.env.DB;
const K1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const K2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const META = 'c3'.repeat(16);
const UID = '04cc0000000001';

async function ownKeyTag(adminAuthTime?: number) {
  const t = await f.org(adminAuthTime);
  const authority = await t.admin.authority();
  const made = await createKeyset(f.kit.ctx, authority, { name: 'S', perTag: true, metaKey: META });
  await importTags(f.kit.ctx, authority, made.id, { csv: `${UID},${K1}`, dryRun: false });
  const { ref } = await tagRef(f.kit.env, t.org.id, 'live', UID);
  const row = await first<{ tag_id: string; kek_version: number }>(
    db(),
    'SELECT s.tag_id, s.kek_version FROM nfc_tag_sun s JOIN nfc_tags t ON t.id = s.tag_id WHERE t.org_id = ? AND t.tag_ref = ?',
    [t.org.id, ref],
  );
  return { t, made, tagId: row?.tag_id ?? '', kek: row?.kek_version ?? 0 };
}
/** Runs `fn` with a rekey grant row present, then removes it (a left-over grant fails the suite). */
async function underRekeyGrant(orgId: string, fn: () => Promise<void>) {
  await insertLeakedGrant(db(), {
    id: `g-${orgId}`,
    scope: 'org_mode',
    orgId,
    mode: 'live',
    purpose: 'org_mode.nfc.keyset.rekey',
  });
  try {
    await fn();
  } finally {
    await run(db(), 'DELETE FROM authority_grants');
    await run(db(), 'DELETE FROM authority_grant_leaks');
  }
}
const swap = (tagId: string, kek: number) =>
  run(
    db(),
    'UPDATE nfc_tag_sun SET iv = randomblob(12), ciphertext = randomblob(32), wrapped_dek = randomblob(60), kek_version = ? WHERE tag_id = ?',
    [kek, tagId],
  );

describe('0196 trigger: replacing a tag key', () => {
  it('refuses a replace with no rekey grant', async () => {
    const { tagId, kek } = await ownKeyTag();
    await expect(swap(tagId, kek)).rejects.toThrow('tag_sun_fixed');
  });

  it('refuses a lower KEK version, even with the grant', async () => {
    const { t, tagId, kek } = await ownKeyTag();
    await underRekeyGrant(t.org.id, async () => {
      await expect(swap(tagId, kek - 1)).rejects.toThrow('tag_sun_fixed');
    });
  });

  it('allows a replace under the grant at the same KEK version', async () => {
    const { t, tagId, kek } = await ownKeyTag();
    await underRekeyGrant(t.org.id, () => swap(tagId, kek).then(() => undefined));
    const row = await first<{ kek_version: number }>(
      db(),
      'SELECT kek_version FROM nfc_tag_sun WHERE tag_id = ?',
      [tagId],
    );
    expect(row?.kek_version).toBe(kek);
  });
});

describe('POST /keysets/:id/import with replace', () => {
  const body = { csv: `${UID},${K2}`, replace: true, dryRun: false };
  const code = async (r: Response) => ((await r.json()) as { code?: string }).code;

  it('asks a stale session for a recent sign-in, but not for a dry run or a plain add', async () => {
    const { t, made } = await ownKeyTag(1);
    const path = `/keysets/${made.id}/import`;
    const replace = await f.call(t.admin.headers, 'POST', path, body);
    expect([replace.status, await code(replace)]).toEqual([403, 'STEP_UP_REQUIRED']);
    const dry = await f.call(t.admin.headers, 'POST', path, { ...body, dryRun: true });
    expect(dry.status).toBe(200);
    const add = await f.call(t.admin.headers, 'POST', path, {
      csv: `04cc0000000002,${K2}`,
      dryRun: true,
    });
    expect(add.status).toBe(200);
  });

  it('passes a fresh session, and records the re-keyed tag', async () => {
    const { t, made, tagId } = await ownKeyTag();
    const r = await f.call(t.admin.headers, 'POST', `/keysets/${made.id}/import`, body);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: 1, added: 1 });
    const audit = await first<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'tag_keyset.rekeyed'",
      [made.id],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ count: 1, tagIds: [tagId] });
  });
});
