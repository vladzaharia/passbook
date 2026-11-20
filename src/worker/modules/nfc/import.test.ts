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
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const K1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const K2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const K3 = '5a4b3c2d1e0f90817263544536271809';
const K4 = '1122334455667788990011223344aabb';
const META = 'c3'.repeat(16);

async function perTag() {
  const t = await f.org();
  const authority = await t.admin.authority();
  const made = await createKeyset(ctx(), authority, {
    name: 'Supplier',
    perTag: true,
    metaKey: META,
  });
  return { t, authority, made };
}
const count = async (orgId: string) =>
  (await first<{ n: number }>(db(), 'SELECT count(*) AS n FROM nfc_tags WHERE org_id = ?', [orgId]))
    ?.n;

describe('create and rotate a keyset of imported tags', () => {
  it('seals the meta key and a random file key nothing returns', async () => {
    const { made } = await perTag();
    expect(made).toMatchObject({ perTag: true, diversify: false, keys: null });
    expect(JSON.stringify(made)).not.toContain(META);
  });

  it('takes the meta key only, on rotate too, and refuses the other shape', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const plain = await createKeyset(ctx(), authority, {
      name: 'Plain',
      diversify: true,
      generate: true,
    });
    const { rotateKeyset } = await import('./keysets.ts');
    await refused(
      rotateKeyset(ctx(), authority, plain.id, { metaKey: META }),
      'KEYSET_KEY_INVALID',
    );
    const own = await createKeyset(ctx(), authority, { name: 'Own', perTag: true, metaKey: K1 });
    await refused(rotateKeyset(ctx(), authority, own.id, { generate: true }), 'KEYSET_KEY_INVALID');
    await refused(
      createKeyset(ctx(), authority, { name: 'Weak', perTag: true, metaKey: '0'.repeat(32) }),
      'KEYSET_KEY_WEAK',
    );
    const rotated = await rotateKeyset(ctx(), authority, own.id, { metaKey: K2 });
    expect(rotated.versions.map((v) => v.state)).toEqual(['retiring', 'active']);
    expect(rotated.keys).toBeNull();
  });
});

describe('import', () => {
  it('a dry run reports and writes nothing', async () => {
    const { t, authority, made } = await perTag();
    const csv = `uid,key\n04aa0000000001,${K1}\n04aa0000000002,${K2}\nnope,${K3}\n`;
    const out = await importTags(ctx(), authority, made.id, { csv, dryRun: true });
    expect(out).toMatchObject({ dryRun: true, rows: 3, ok: 2, added: 0, moreProblems: 0 });
    expect(out.problems).toEqual([{ line: 4, uid: null, reason: 'bad_uid' }]);
    expect(await count(t.org.id)).toBe(0);
  });

  it('adds spares with sealed keys, reports duplicates and bad rows, and a second run adds none', async () => {
    const { t, authority, made } = await perTag();
    // An existing Basic tag of the same UID is a duplicate: one physical tag has one identity.
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', '04aa0000000003');
    await run(
      db(),
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('basic-1', ?, 'live', ?, 'uid', ?, 1)",
      [t.org.id, ref, hint],
    );
    const csv = [
      'uid,key',
      `04aa0000000001,${K1}`,
      `04aa0000000002,${K2}`,
      `04aa0000000002,${K3}`,
      `04aa0000000003,${K3}`,
      `04aa0000000004,${'0'.repeat(32)}`,
      `04aa0000000005,${K4}`,
    ].join('\n');
    const out = await importTags(ctx(), authority, made.id, { csv, dryRun: false });
    expect(out).toMatchObject({ rows: 6, ok: 3, added: 3 });
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [4, 'dup_file'],
      [5, 'exists'],
      [6, 'weak_key'],
    ]);
    expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{32}/);
    expect(await count(t.org.id)).toBe(4);
    const again = await importTags(ctx(), authority, made.id, { csv, dryRun: false });
    expect(again).toMatchObject({ added: 0, ok: 0 });
    expect(await count(t.org.id)).toBe(4);
  });

  it('seals each tag key for that tag, keyset, mode and org, and writes it nowhere else', async () => {
    const { t, authority, made } = await perTag();
    await importTags(ctx(), authority, made.id, {
      csv: `04aa0000000001,${K1}\n04aa0000000002,${K2}`,
      dryRun: false,
    });
    const rows = await all<{
      tag_id: string;
      ciphertext: ArrayBuffer;
      iv: ArrayBuffer;
      wrapped_dek: ArrayBuffer;
      kek_version: number;
      ctr: number;
      key_version: number;
    }>(
      db(),
      `SELECT s.* FROM nfc_tag_sun s JOIN nfc_tags t ON t.id = s.tag_id WHERE t.org_id = ? ORDER BY t.created_at, t.id`,
      [t.org.id],
    );
    expect(rows).toHaveLength(2);
    const ring = await loadKekRing(f.kit.env);
    const scope = { orgId: t.org.id, mode: 'live', keysetId: made.id } as const;
    const opened: string[] = [];
    for (const r of rows) {
      const envelope = {
        kekVersion: r.kek_version,
        iv: new Uint8Array(r.iv),
        wrappedDek: new Uint8Array(r.wrapped_dek),
        ciphertext: new Uint8Array(r.ciphertext),
      };
      const key = await openTagKey(ring, scope, r.tag_id, envelope);
      opened.push(Array.from(key, (b) => b.toString(16).padStart(2, '0')).join(''));
      expect(r).toMatchObject({ ctr: 0, key_version: 1 });
      // Not for another tag, keyset, mode or org.
      const other = rows.find((x) => x.tag_id !== r.tag_id)?.tag_id ?? '';
      await expect(openTagKey(ring, scope, other, envelope)).rejects.toMatchObject({
        code: 'TAG_KEY_UNREADABLE',
      });
      await expect(
        openTagKey(ring, { ...scope, keysetId: 'other' }, r.tag_id, envelope),
      ).rejects.toMatchObject({ code: 'TAG_KEY_UNREADABLE' });
      await expect(
        openTagKey(ring, { ...scope, mode: 'test' }, r.tag_id, envelope),
      ).rejects.toMatchObject({ code: 'TAG_KEY_UNREADABLE' });
      await expect(
        openTagKey(ring, { ...scope, orgId: 'other' }, r.tag_id, envelope),
      ).rejects.toMatchObject({ code: 'TAG_KEY_UNREADABLE' });
    }
    expect(opened.sort()).toEqual([K2, K1].sort());
    // No plaintext in the audit rows or the stored columns.
    const audits = await all<{ detail: string; action: string }>(
      db(),
      "SELECT action, detail FROM audit_log WHERE target_id = ? AND action = 'tag_keyset.import'",
      [made.id],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]?.detail ?? '{}')).toMatchObject({ attempted: 2, version: 1 });
    expect(JSON.stringify(audits)).not.toContain(K1);
    for (const r of rows) expect(Buffer.from(r.ciphertext).toString('hex')).not.toContain(K1);
  });

  it('refuses a tag key equal to the keyset meta key, and keys two rows share', async () => {
    const { authority, made } = await perTag();
    const csv = [
      `04aa0000000001,${META}`,
      `04aa0000000002,${K1}`,
      `04aa0000000003,${K2}`,
      `04aa0000000004,${K2}`,
    ].join('\n');
    const out = await importTags(ctx(), authority, made.id, { csv, dryRun: false });
    expect(out).toMatchObject({ ok: 1, added: 1 });
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [1, 'meta_key'],
      [3, 'dup_key'],
      [4, 'dup_key'],
    ]);
  });

  it('refuses a keyset that takes no imported tags, a disabled one, and a file that is too big', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const plain = await createKeyset(ctx(), authority, {
      name: 'Plain',
      diversify: true,
      generate: true,
    });
    const csv = `04aa0000000001,${K1}`;
    await refused(
      importTags(ctx(), authority, plain.id, { csv, dryRun: true }),
      'KEYSET_NOT_PER_TAG',
    );
    const own = await createKeyset(ctx(), authority, { name: 'Own', perTag: true, metaKey: META });
    const rows = Array.from(
      { length: 501 },
      (_, i) => `04bb${i.toString(16).padStart(10, '0')},${K1}`,
    );
    await refused(
      importTags(ctx(), authority, own.id, { csv: rows.join('\n'), dryRun: false }),
      'IMPORT_TOO_MANY',
    );
    await disableKeyset(ctx(), authority, own.id);
    await refused(importTags(ctx(), authority, own.id, { csv, dryRun: false }), 'KEYSET_DISABLED');
    expect(await count(t.org.id)).toBe(0);
  });

  it('keeps tenants apart: another org and another mode cannot import into a keyset, or see its tags', async () => {
    const mine = await perTag();
    const theirs = await f.org();
    const stranger = await theirs.admin.authority();
    const csv = `04aa0000000001,${K1}`;
    await refused(
      importTags(ctx(), stranger, mine.made.id, { csv, dryRun: false }),
      'KEYSET_NOT_FOUND',
    );
    await refused(
      importTags(ctx(), await mine.t.admin.authority('test'), mine.made.id, { csv, dryRun: false }),
      'KEYSET_NOT_FOUND',
    );
    expect(await count(mine.t.org.id)).toBe(0);
    expect(await count(theirs.org.id)).toBe(0);
    // The same UID in two orgs is two tags.
    const other = await createKeyset(ctx(), stranger, { name: 'Own', perTag: true, metaKey: K3 });
    await importTags(ctx(), mine.authority, mine.made.id, { csv, dryRun: false });
    expect(await importTags(ctx(), stranger, other.id, { csv, dryRun: false })).toMatchObject({
      added: 1,
    });
  });
});
