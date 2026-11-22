import { beforeAll, describe, expect, it } from 'vitest';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { importTags } from './import.ts';
import { openTagKey } from './keyset-seal.ts';
import { createKeyset, disableKeyset } from './keysets.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { tagRef } from './tag-ref.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const ctx = () => f.kit.ctx;
const db = () => f.kit.env.DB;
const K1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const K2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const K3 = '5a4b3c2d1e0f90817263544536271809';
const META = 'c3'.repeat(16);

async function keyset(name: string, t: Awaited<ReturnType<typeof f.org>>, metaKey = META) {
  const authority = await t.admin.authority();
  const made = await createKeyset(ctx(), authority, { name, perTag: true, metaKey });
  return { authority, made };
}

const stored = (orgId: string, uid: string) =>
  tagRef(f.kit.env, orgId, 'live', uid).then(({ ref }) =>
    first<{
      tag_id: string;
      keyset_id: string;
      ctr: number;
      key_version: number;
      kek_version: number;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      ciphertext: ArrayBuffer;
    }>(
      db(),
      'SELECT s.* FROM nfc_tag_sun s JOIN nfc_tags t ON t.id = s.tag_id WHERE t.org_id = ? AND t.tag_ref = ?',
      [orgId, ref],
    ),
  );
const keyOf = async (orgId: string, keysetId: string, uid: string) => {
  const row = await stored(orgId, uid);
  if (!row) throw new Error('No tag.');
  const key = await openTagKey(
    await loadKekRing(f.kit.env),
    { orgId, mode: 'live', keysetId },
    row.tag_id,
    {
      kekVersion: row.kek_version,
      iv: new Uint8Array(row.iv),
      wrappedDek: new Uint8Array(row.wrapped_dek),
      ciphertext: new Uint8Array(row.ciphertext),
    },
  );
  return Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('');
};

describe('replace tag keys by import', () => {
  it('swaps the sealed key of a tag already on the keyset, keeping its row and counter', async () => {
    const t = await f.org();
    const { authority, made } = await keyset('Supplier', t);
    await importTags(ctx(), authority, made.id, {
      csv: `04bb0000000001,${K1}`,
      dryRun: false,
    });
    const before = await stored(t.org.id, '04bb0000000001');
    await run(db(), 'UPDATE nfc_tag_sun SET ctr = 7 WHERE tag_id = ?', [before?.tag_id ?? '']);
    const dry = await importTags(ctx(), authority, made.id, {
      csv: `04bb0000000001,${K2}`,
      dryRun: true,
      replace: true,
    });
    expect(dry).toMatchObject({ ok: 1, added: 0 });
    expect(await keyOf(t.org.id, made.id, '04bb0000000001')).toBe(K1);
    const out = await importTags(ctx(), authority, made.id, {
      csv: `04bb0000000001,${K2}`,
      dryRun: false,
      replace: true,
    });
    expect(out).toMatchObject({ ok: 1, added: 1, problems: [] });
    expect(JSON.stringify(out)).not.toContain(K2);
    const after = await stored(t.org.id, '04bb0000000001');
    expect(after).toMatchObject({ tag_id: before?.tag_id, ctr: 7, key_version: 1 });
    expect(await keyOf(t.org.id, made.id, '04bb0000000001')).toBe(K2);
    const audits = await all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE target_id = ? AND action = 'tag_keyset.rekey'",
      [made.id],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(K2);
  });

  it('lists tags that are new, on another keyset, or hold no key of their own, and adds nothing', async () => {
    const t = await f.org();
    const { authority, made } = await keyset('Supplier', t);
    const other = await keyset('Other', t, '3c'.repeat(16));
    await importTags(ctx(), other.authority, other.made.id, {
      csv: `04bb0000000012,${K1}`,
      dryRun: false,
    });
    const out = await importTags(ctx(), authority, made.id, {
      csv: `04bb0000000011,${K2}\n04bb0000000012,${K3}`,
      dryRun: false,
      replace: true,
    });
    expect(out).toMatchObject({ ok: 0, added: 0 });
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [1, 'not_on_keyset'],
      [2, 'not_on_keyset'],
    ]);
    expect(await stored(t.org.id, '04bb0000000011')).toBeNull();
    expect(await keyOf(t.org.id, other.made.id, '04bb0000000012')).toBe(K1);
  });

  it('still refuses the meta key and a disabled keyset', async () => {
    const t = await f.org();
    const { authority, made } = await keyset('Supplier', t);
    await importTags(ctx(), authority, made.id, { csv: `04bb0000000021,${K1}`, dryRun: false });
    const out = await importTags(ctx(), authority, made.id, {
      csv: `04bb0000000021,${META}`,
      dryRun: false,
      replace: true,
    });
    expect(out.problems.map((p) => p.reason)).toEqual(['meta_key']);
    expect(await keyOf(t.org.id, made.id, '04bb0000000021')).toBe(K1);
    await disableKeyset(ctx(), authority, made.id);
    await expect(
      importTags(ctx(), authority, made.id, {
        csv: `04bb0000000021,${K2}`,
        dryRun: false,
        replace: true,
      }),
    ).rejects.toMatchObject({ code: 'KEYSET_DISABLED' });
    // The table itself no longer allows a new key on a disabled keyset, or on a tag with no key of its own.
    const row = await stored(t.org.id, '04bb0000000021');
    await expect(
      run(
        db(),
        "UPDATE nfc_tag_sun SET iv = x'01', ciphertext = x'02', wrapped_dek = x'03' WHERE tag_id = ?",
        [row?.tag_id ?? ''],
      ),
    ).rejects.toThrow('tag_sun_fixed');
  });
});
