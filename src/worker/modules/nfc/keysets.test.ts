import { beforeAll, describe, expect, it } from 'vitest';
import { loadKekRing } from '../../platform/crypto.ts';
import { all, first, run } from '../../platform/db.ts';
import { openTagKey, openVersion, sealTagKey, sealVersion } from './keyset-seal.ts';
import {
  createKeyset,
  disableKeyset,
  KEYSETS_PER_ORG_MODE,
  keysetView,
  retireKeyVersion,
  rotateKeyset,
  verifyingKeys,
} from './keysets.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { keysetById, versionEnvelopes } from './repo-keysets.ts';
import { bytesToHex } from './sun.ts';
import { tagRef } from './tag-ref.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const ctx = () => f.kit.ctx;
const db = () => f.kit.env.DB;
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const GENERATE = { name: 'Badges', diversify: true, generate: true } as const;
const HEX = /[0-9a-f]{32}/;
async function rowOf(id: string) {
  const row = await keysetById(db(), id);
  if (!row) throw new Error('No keyset.');
  return row;
}

async function keyset(options: { mode?: 'live' | 'test' } = {}) {
  const t = await f.org();
  const authority = await t.admin.authority(options.mode);
  const made = await createKeyset(ctx(), authority, GENERATE);
  return { t, authority, made };
}

describe('create', () => {
  it('shows generated keys once and stores only the sealed envelope', async () => {
    const { authority, made } = await keyset();
    expect(made.keys?.metaKey).toMatch(/^[0-9a-f]{32}$/);
    expect(made.keys?.fileKey).toMatch(/^[0-9a-f]{32}$/);
    expect(made.keys?.metaKey).not.toBe(made.keys?.fileKey);
    expect(made).toMatchObject({ diversify: true, disabledAt: null });
    expect(made.slug).toMatch(/^[a-z0-9]{8}$/);
    expect(made.versions).toEqual([
      {
        version: 1,
        state: 'active',
        createdAt: expect.any(Number),
        stateAt: null,
        revokedAt: null,
        tags: 0,
      },
    ]);
    const [stored] = await versionEnvelopes(db(), made.id);
    const cipher = bytesToHex(stored?.envelope.ciphertext ?? new Uint8Array());
    expect(stored?.envelope.ciphertext.length).toBe(48);
    expect(stored?.envelope.kekVersion).toBe(1);
    expect(cipher).not.toContain(made.keys?.metaKey);
    expect(cipher).not.toContain(made.keys?.fileKey);
    // Nothing reads the keys back: not the view, not the audit row.
    const again = JSON.stringify(await keysetView(ctx(), authority, made.id));
    expect(again).not.toContain(made.keys?.metaKey);
    expect(again).not.toContain(made.keys?.fileKey);
    expect(again).not.toMatch(HEX);
    const audits = await all<{ detail: string }>(
      db(),
      "SELECT detail FROM audit_log WHERE action = 'tag_keyset.create' AND target_id = ?",
      [made.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).not.toMatch(HEX);
  });

  it('seals entered keys and does not echo them', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const metaKey = '00112233445566778899aabbccddeeff';
    const fileKey = 'ffeeddccbbaa99887766554433221100';
    const made = await createKeyset(ctx(), authority, {
      name: 'Supplier',
      diversify: false,
      metaKey,
      fileKey,
    });
    expect(made.keys).toBeNull();
    expect(made.diversify).toBe(false);
    const keys = await verifyingKeys(ctx(), await rowOf(made.id));
    expect(bytesToHex(keys[0]?.metaKey ?? new Uint8Array())).toBe(metaKey);
    expect(bytesToHex(keys[0]?.fileKey ?? new Uint8Array())).toBe(fileKey);
    expect(keys[0]?.diversified).toBe(false);
  });

  it('refuses a factory-default key and one key for both roles', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const k = 'aabbccddeeff00112233445566778899';
    const weak: [string, string][] = [
      ['0'.repeat(32), k],
      [k, '0'.repeat(32)],
      [k, k],
    ];
    for (const [metaKey, fileKey] of weak)
      await refused(
        createKeyset(ctx(), authority, { name: 'X', diversify: true, metaKey, fileKey }),
        'KEYSET_KEY_WEAK',
      );
    expect(
      await first(db(), 'SELECT 1 AS x FROM nfc_tag_keysets WHERE org_id = ?', [t.org.id]),
    ).toBeNull();
  });

  it('gives each keyset its own slug and keys', async () => {
    const a = await keyset();
    const b = await keyset();
    expect(a.made.slug).not.toBe(b.made.slug);
    expect(a.made.keys?.metaKey).not.toBe(b.made.keys?.metaKey);
  });
});

describe('four keysets per org and mode', () => {
  it('refuses the fifth, frees a slot on disable, and counts each mode and org apart', async () => {
    const t = await f.org();
    const live = await t.admin.authority('live');
    const test = await t.admin.authority('test');
    const made = [];
    for (let i = 0; i < KEYSETS_PER_ORG_MODE; i++)
      made.push(await createKeyset(ctx(), live, GENERATE));
    await refused(createKeyset(ctx(), live, GENERATE), 'KEYSET_LIMIT');
    // Test mode and another org have their own four.
    await createKeyset(ctx(), test, GENERATE);
    await createKeyset(ctx(), await (await f.org()).admin.authority(), GENERATE);
    const first = made[0];
    if (!first) throw new Error('No keyset.');
    await disableKeyset(ctx(), live, first.id);
    await createKeyset(ctx(), live, GENERATE);
    await refused(createKeyset(ctx(), live, GENERATE), 'KEYSET_LIMIT');
  });

  it('is held by the database too', async () => {
    const t = await f.org();
    const live = await t.admin.authority();
    for (let i = 0; i < KEYSETS_PER_ORG_MODE; i++) await createKeyset(ctx(), live, GENERATE);
    await expect(
      run(
        db(),
        "INSERT INTO nfc_tag_keysets (id, org_id, mode, name, slug, diversify, created_at, created_by) VALUES ('raw-k', ?, 'live', 'x', 'zzzzzzzz', 1, 1, 'x')",
        [t.org.id],
      ),
    ).rejects.toThrow(/keyset_limit/);
  });
});

describe('sealed keys are bound to where they were sealed', () => {
  const scope = { orgId: 'o1', mode: 'live', keysetId: 'k1', keyId: 'key-1', version: 1 } as const;
  const meta = new Uint8Array(16).map((_, i) => i + 1);
  const file = new Uint8Array(16).map((_, i) => i + 101);

  it('opens only under the org, mode, keyset, version and row it was sealed for', async () => {
    const ring = await loadKekRing(f.kit.env);
    const sealed = await sealVersion(ring, scope, meta, file);
    expect(await openVersion(ring, scope, sealed)).toEqual({ meta, file });
    for (const wrong of [
      { ...scope, orgId: 'o2' },
      { ...scope, mode: 'test' as const },
      { ...scope, keysetId: 'k2' },
      { ...scope, version: 2 },
      { ...scope, keyId: 'key-2' },
    ])
      await refused(openVersion(ring, wrong, sealed), 'TAG_KEY_UNREADABLE');
  });

  it('opens a per-tag key only for its tag, keyset, mode and org', async () => {
    const ring = await loadKekRing(f.kit.env);
    const sealed = await sealTagKey(ring, scope, 't1', meta);
    expect(await openTagKey(ring, scope, 't1', sealed)).toEqual(meta);
    for (const attempt of [
      openTagKey(ring, scope, 't2', sealed),
      openTagKey(ring, { ...scope, keysetId: 'k2' }, 't1', sealed),
      openTagKey(ring, { ...scope, mode: 'test' }, 't1', sealed),
      openTagKey(ring, { ...scope, orgId: 'o2' }, 't1', sealed),
      // A tag key is not a keyset version, and a version is not a tag key.
      openVersion(ring, scope, sealed),
      openTagKey(ring, scope, 'key-1', await sealVersion(ring, scope, meta, file)),
    ])
      await refused(attempt, 'TAG_KEY_UNREADABLE');
  });

  it('refuses damaged columns, a missing KEK and a key of the wrong size', async () => {
    const ring = await loadKekRing(f.kit.env);
    const sealed = await sealVersion(ring, scope, meta, file);
    const flip = (b: Uint8Array) => b.map((x, i) => (i === 0 ? x ^ 1 : x));
    for (const bad of [
      { ...sealed, iv: flip(sealed.iv) },
      { ...sealed, wrappedDek: flip(sealed.wrappedDek) },
      { ...sealed, ciphertext: flip(sealed.ciphertext) },
      { ...sealed, ciphertext: sealed.ciphertext.slice(1) },
      { ...sealed, kekVersion: 99 },
    ])
      await refused(openVersion(ring, scope, bad), 'TAG_KEY_UNREADABLE');
    await refused(sealVersion(ring, scope, new Uint8Array(15), file), 'TAG_KEY_UNREADABLE');
    await refused(sealTagKey(ring, scope, 't1', new Uint8Array(17)), 'TAG_KEY_UNREADABLE');
  });

  it('a stored row opened as another keyset, mode, version or row does not open', async () => {
    const a = await keyset();
    const b = await keyset({ mode: 'test' });
    const ring = await loadKekRing(f.kit.env);
    const [row] = await versionEnvelopes(db(), a.made.id);
    if (!row) throw new Error('No key.');
    const own = {
      orgId: a.t.org.id,
      mode: 'live',
      keysetId: a.made.id,
      keyId: row.id,
      version: 1,
    } as const;
    expect((await openVersion(ring, own, row.envelope)).meta.length).toBe(16);
    for (const wrong of [
      { ...own, orgId: b.t.org.id, mode: 'test' as const, keysetId: b.made.id },
      { ...own, mode: 'test' as const },
      { ...own, version: 2 },
      { ...own, keyId: 'other' },
    ])
      await refused(openVersion(ring, wrong, row.envelope), 'TAG_KEY_UNREADABLE');
  });

  it('a keyset whose row was swapped for another keyset’s fails to verify', async () => {
    const a = await keyset();
    const b = await keyset();
    const [rowB] = await versionEnvelopes(db(), b.made.id);
    if (!rowB) throw new Error('No key.');
    // The database refuses a rewrite of the envelope; drop that guard only to prove the seal still holds.
    await run(db(), 'DROP TRIGGER nfc_tag_keys_update');
    await run(
      db(),
      'UPDATE nfc_tag_keys SET iv = ?, wrapped_dek = ?, ciphertext = ? WHERE keyset_id = ?',
      [rowB.envelope.iv, rowB.envelope.wrappedDek, rowB.envelope.ciphertext, a.made.id],
    );
    await refused(verifyingKeys(ctx(), await rowOf(a.made.id)), 'TAG_KEY_UNREADABLE');
    expect(await verifyingKeys(ctx(), await rowOf(b.made.id))).toHaveLength(1);
  });
});

describe('rotate, retire and disable', () => {
  it('rotation keeps the old key verifying until it is retired, then it stops', async () => {
    const { authority, made } = await keyset();
    const k1 = await verifyingKeys(ctx(), await rowOf(made.id));
    const rotated = await rotateKeyset(ctx(), authority, made.id, { generate: true });
    expect(rotated.keys?.metaKey).toMatch(/^[0-9a-f]{32}$/);
    expect(rotated.versions.map((v) => [v.version, v.state])).toEqual([
      [1, 'retiring'],
      [2, 'active'],
    ]);
    const row = await rowOf(made.id);
    const both = await verifyingKeys(ctx(), row);
    expect(both.map((k) => k.version)).toEqual([2, 1]);
    expect(both[1]?.metaKey).toEqual(k1[0]?.metaKey);
    expect(bytesToHex(both[0]?.metaKey ?? new Uint8Array())).toBe(rotated.keys?.metaKey);
    // One old version at a time.
    await refused(
      rotateKeyset(ctx(), authority, made.id, { generate: true }),
      'KEYSET_RETIRE_FIRST',
    );
    // The active key is not retired.
    await refused(retireKeyVersion(ctx(), authority, made.id, 2), 'KEYSET_KEY_ACTIVE');
    await refused(retireKeyVersion(ctx(), authority, made.id, 9), 'KEYSET_KEY_NOT_FOUND');
    const retired = await retireKeyVersion(ctx(), authority, made.id, 1);
    expect(retired.versions.map((v) => [v.version, v.state])).toEqual([
      [1, 'retired'],
      [2, 'active'],
    ]);
    expect(await verifyingKeys(ctx(), row)).toHaveLength(1);
    expect((await versionEnvelopes(db(), made.id, ['retired'])).map((v) => v.version)).toEqual([1]);
    // Again is a no-op, and a rotation can follow.
    await retireKeyVersion(ctx(), authority, made.id, 1);
    const third = await rotateKeyset(ctx(), authority, made.id, { generate: true });
    expect(third.versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('rotates to entered keys, and refuses weak ones', async () => {
    const { authority, made } = await keyset();
    const metaKey = '00112233445566778899aabbccddeeff';
    const fileKey = 'ffeeddccbbaa99887766554433221100';
    await refused(
      rotateKeyset(ctx(), authority, made.id, { metaKey: '0'.repeat(32), fileKey }),
      'KEYSET_KEY_WEAK',
    );
    const rotated = await rotateKeyset(ctx(), authority, made.id, { metaKey, fileKey });
    expect(rotated.keys).toBeNull();
    const [active] = await verifyingKeys(ctx(), await rowOf(made.id));
    expect(bytesToHex(active?.fileKey ?? new Uint8Array())).toBe(fileKey);
  });

  it('refuses entered keys this keyset has already used, retired ones included', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const meta = '00112233445566778899aabbccddeeff';
    const file = 'ffeeddccbbaa99887766554433221100';
    const made = await createKeyset(ctx(), authority, {
      name: 'Own keys',
      diversify: false,
      metaKey: meta,
      fileKey: file,
    });
    const fresh = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    for (const keys of [
      { metaKey: meta, fileKey: file },
      { metaKey: fresh, fileKey: file },
      { metaKey: meta, fileKey: fresh },
      // A key in the other role is still a reused key.
      { metaKey: file, fileKey: fresh },
    ])
      await refused(rotateKeyset(ctx(), authority, made.id, keys), 'KEYSET_KEY_REUSED');
    await rotateKeyset(ctx(), authority, made.id, {
      metaKey: fresh,
      fileKey: 'aaaaaaaabbbbbbbbccccccccdddddddd',
    });
    await retireKeyVersion(ctx(), authority, made.id, 1);
    await refused(
      rotateKeyset(ctx(), authority, made.id, {
        metaKey: meta,
        fileKey: 'abcdefabcdefabcdefabcdefabcdefab',
      }),
      'KEYSET_KEY_REUSED',
    );
  });

  it('keeps a version while tags use it, and counts them', async () => {
    const { t, authority, made } = await keyset();
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', f.nextUid());
    await run(
      db(),
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('sun-1', ?, 'live', ?, 'sun', ?, 1)",
      [t.org.id, ref, hint],
    );
    await run(
      db(),
      "INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES ('sun-1', ?, 1, 5, 1)",
      [made.id],
    );
    await rotateKeyset(ctx(), authority, made.id, { generate: true });
    const listed = await retireKeyVersion(ctx(), authority, made.id, 1).catch((e) => e);
    expect(listed).toMatchObject({ code: 'KEYSET_KEY_IN_USE' });
    expect(listed.message).toContain('1 tags');
    await run(db(), 'UPDATE nfc_tag_sun SET key_version = 2 WHERE tag_id = ?', ['sun-1']);
    const view = await retireKeyVersion(ctx(), authority, made.id, 1);
    expect(view.versions.map((v) => [v.version, v.state, v.tags])).toEqual([
      [1, 'retired', 0],
      [2, 'active', 1],
    ]);
  });

  it('disable refuses every tag at once and stays disabled', async () => {
    const { t, authority, made } = await keyset();
    await rotateKeyset(ctx(), authority, made.id, { generate: true });
    const disabled = await disableKeyset(ctx(), authority, made.id);
    expect(disabled.disabledAt).not.toBeNull();
    expect(disabled.versions.map((v) => v.state)).toEqual(['retired', 'retired']);
    const row = await rowOf(made.id);
    expect(await verifyingKeys(ctx(), row)).toEqual([]);
    await refused(rotateKeyset(ctx(), authority, made.id, { generate: true }), 'KEYSET_DISABLED');
    // Again changes nothing, and nothing turns it back on.
    expect((await disableKeyset(ctx(), authority, made.id)).disabledAt).toBe(disabled.disabledAt);
    await expect(
      run(db(), 'UPDATE nfc_tag_keysets SET disabled_at = NULL WHERE id = ?', [made.id]),
    ).rejects.toThrow(/keyset_disabled/);
    const audits = await all<{ action: string }>(
      db(),
      "SELECT action FROM audit_log WHERE target_id = ? AND target_type = 'tag_keyset' ORDER BY id",
      [made.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      'tag_keyset.create',
      'tag_keyset.rotate',
      'tag_keyset.disable',
    ]);
    expect(t.org.id).toBeTruthy();
  });
});

describe('tenant isolation', () => {
  it('another org, another mode and a member without the capability see no keyset', async () => {
    const a = await keyset();
    const other = await f.org();
    const otherAdmin = await other.admin.authority();
    const sameOrgTest = await a.t.admin.authority('test');
    for (const bad of [otherAdmin, sameOrgTest]) {
      await refused(rotateKeyset(ctx(), bad, a.made.id, { generate: true }), 'KEYSET_NOT_FOUND');
      await refused(retireKeyVersion(ctx(), bad, a.made.id, 1), 'KEYSET_NOT_FOUND');
      await refused(disableKeyset(ctx(), bad, a.made.id), 'KEYSET_NOT_FOUND');
    }
    expect((await keysetById(db(), a.made.id))?.disabledAt).toBeNull();
    // A pass operator has scanning:read, not scanning:manage.
    await expect(a.t.operator.authority()).rejects.toMatchObject({ status: 403 });
  });
});

describe('entered keys', () => {
  it('may not repeat in any keyset of the org, in either mode', async () => {
    const t = await f.org();
    const live = await t.admin.authority('live');
    const test = await t.admin.authority('test');
    const keys = {
      metaKey: '0102030405060708090a0b0c0d0e0f10',
      fileKey: '1112131415161718191a1b1c1d1e1f20',
    };
    await createKeyset(ctx(), live, { name: 'One', diversify: false, ...keys });
    await refused(
      createKeyset(ctx(), live, { name: 'Two', diversify: false, ...keys }),
      'KEYSET_KEY_REUSED',
    );
    await refused(
      createKeyset(ctx(), test, { name: 'Test', diversify: false, ...keys }),
      'KEYSET_KEY_REUSED',
    );
    // One key of the pair is enough to be a repeat.
    await refused(
      createKeyset(ctx(), test, {
        name: 'Test',
        diversify: false,
        ...keys,
        fileKey: '2122232425262728292a2b2c2d2e2f30',
      }),
      'KEYSET_KEY_REUSED',
    );
    await createKeyset(ctx(), test, {
      name: 'Test',
      diversify: false,
      metaKey: '3132333435363738393a3b3c3d3e3f40',
      fileKey: '4142434445464748494a4b4c4d4e4f50',
    });
  });
});
