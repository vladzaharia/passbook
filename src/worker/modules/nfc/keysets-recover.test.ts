import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { sunTap } from '../scan/sun-test-fixtures.ts';
import { createKeyset, disableKeyset, retireKeyVersion, rotateKeyset } from './keysets.ts';
import { reenrolTags, revokeKeyVersion } from './keysets-recover.ts';
import { keysetFixture } from './keysets-test-fixtures.ts';
import { hexToBytes } from './sun.ts';
import { verifySunTap } from './systems/sun.ts';
import { tagRef } from './tag-ref.ts';

let f: Awaited<ReturnType<typeof keysetFixture>>;
beforeAll(async () => {
  f = await keysetFixture();
});

const ctx = () => f.kit.ctx;
const db = () => f.kit.env.DB;
const refused = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });
const rawFails = (sql: string, params: (string | number)[], text: string) =>
  expect(run(db(), sql, params)).rejects.toThrow(text);

async function made(
  authority: Awaited<ReturnType<(typeof f)['org']>>['admin']['authority'] extends (
    ...a: never[]
  ) => infer R
    ? Awaited<R>
    : never,
) {
  const keyset = await createKeyset(ctx(), authority, {
    name: 'Badges',
    diversify: false,
    generate: true,
  });
  const keys = keyset.keys;
  if (!keys) throw new Error('No keys.');
  return {
    keyset,
    tapKeys: (version = keyset.slug) => ({
      slug: version,
      meta: hexToBytes(keys.metaKey) as Uint8Array,
      file: hexToBytes(keys.fileKey) as Uint8Array,
      diversify: false,
    }),
  };
}

let n = 0;
/** A Secure tag on the keyset's version 1, as an enrolment leaves it. */
async function tag(orgId: string, keysetId: string, ctr = 3, version = 1) {
  const uid = `04cc${(++n).toString(16).padStart(10, '0')}`;
  const { ref, hint } = await tagRef(f.kit.env, orgId, 'live', uid);
  const id = `rc-${n}`;
  await run(
    db(),
    "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES (?, ?, 'live', ?, 'sun', ?, 1)",
    [id, orgId, ref, hint],
  );
  await run(
    db(),
    'INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES (?, ?, ?, ?, 1)',
    [id, keysetId, version, ctr],
  );
  return { id, uid };
}
const audit = (id: string, action: string) =>
  all<{ detail: string }>(db(), 'SELECT detail FROM audit_log WHERE target_id = ? AND action = ?', [
    id,
    action,
  ]);

describe('revoke one key version', () => {
  it('cuts off a version with tags still on it, where retire refuses', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const { keyset, tapKeys } = await made(authority);
    const a = await tag(t.org.id, keyset.id);
    await tag(t.org.id, keyset.id);
    const old = tapKeys();
    const rotated = await rotateKeyset(ctx(), authority, keyset.id, { generate: true });
    await refused(retireKeyVersion(ctx(), authority, keyset.id, 1), 'KEYSET_KEY_IN_USE');
    const view = await revokeKeyVersion(ctx(), authority, keyset.id, 1);
    expect(view.versions.map((v) => [v.version, v.state, v.tags, v.revokedAt !== null])).toEqual([
      [1, 'retired', 2, true],
      [2, 'active', 0, false],
    ]);
    const rows = await audit(keyset.id, 'tag_keyset.revoke_key');
    expect(rows.map((r) => JSON.parse(r.detail))).toEqual([
      { version: 1, was: 'retiring', tags: 2 },
    ]);
    // The revoked keys verify nothing, tags included; the new version does.
    const live = {
      slug: keyset.slug,
      meta: hexToBytes(rotated.keys?.metaKey ?? '') as Uint8Array,
      file: hexToBytes(rotated.keys?.fileKey ?? '') as Uint8Array,
      diversify: false,
    };
    expect(await verifySunTap(ctx(), t.org.id, 'live', await sunTap(old, a.uid, 5))).toMatchObject({
      ok: false,
      code: 'TAG_SUN_VERIFY',
    });
    expect(await verifySunTap(ctx(), t.org.id, 'live', await sunTap(live, a.uid, 6))).toMatchObject(
      {
        ok: true,
        proof: { keyVersion: 2, active: true },
      },
    );
    // A tag written with the new keys moves up; nothing moves a tag back down, or unrevokes a version.
    await run(db(), 'UPDATE nfc_tag_sun SET key_version = 2, ctr = 6 WHERE tag_id = ?', [a.id]);
    await rawFails(
      'UPDATE nfc_tag_sun SET key_version = 1 WHERE tag_id = ?',
      [a.id],
      'tag_sun_version',
    );
    await rawFails(
      'UPDATE nfc_tag_keys SET revoked_at = NULL WHERE keyset_id = ? AND version = 1',
      [keyset.id],
      'tag_key_revoked',
    );
    await rawFails(
      "UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = ? AND version = 1",
      [keyset.id],
      'tag_key_state',
    );
  });

  it('revokes the active version and leaves none; a rotation adds the next one', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const { keyset, tapKeys } = await made(authority);
    const a = await tag(t.org.id, keyset.id);
    const view = await revokeKeyVersion(ctx(), authority, keyset.id, 1);
    expect(view.versions.map((v) => v.state)).toEqual(['retired']);
    expect(
      await verifySunTap(ctx(), t.org.id, 'live', await sunTap(tapKeys(), a.uid, 5)),
    ).toMatchObject({ ok: false });
    const next = await rotateKeyset(ctx(), authority, keyset.id, { generate: true });
    expect(next.versions.map((v) => [v.version, v.state])).toEqual([
      [1, 'retired'],
      [2, 'active'],
    ]);
  });

  it('answers a retired version again without a second audit row, and refuses a missing one', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const { keyset } = await made(authority);
    await revokeKeyVersion(ctx(), authority, keyset.id, 1);
    await revokeKeyVersion(ctx(), authority, keyset.id, 1);
    expect(await audit(keyset.id, 'tag_keyset.revoke_key')).toHaveLength(1);
    await refused(revokeKeyVersion(ctx(), authority, keyset.id, 9), 'KEYSET_KEY_NOT_FOUND');
  });

  it('keeps tenants apart', async () => {
    const mine = await f.org();
    const theirs = await f.org();
    const { keyset } = await made(await mine.admin.authority());
    await refused(
      revokeKeyVersion(ctx(), await theirs.admin.authority(), keyset.id, 1),
      'KEYSET_NOT_FOUND',
    );
    await refused(
      revokeKeyVersion(ctx(), await mine.admin.authority('test'), keyset.id, 1),
      'KEYSET_NOT_FOUND',
    );
  });
});

describe('a retiring version enrols no new tag', () => {
  it('is held by the database: a side row goes on the active version only', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const { keyset } = await made(authority);
    await rotateKeyset(ctx(), authority, keyset.id, { generate: true });
    const { ref, hint } = await tagRef(f.kit.env, t.org.id, 'live', '04dd00000000aa');
    await run(
      db(),
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('ne-1', ?, 'live', ?, 'sun', ?, 1)",
      [t.org.id, ref, hint],
    );
    await rawFails(
      'INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES (?, ?, 1, 0, 1)',
      ['ne-1', keyset.id],
      'tag_key_state',
    );
    await run(
      db(),
      'INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES (?, ?, 2, 0, 1)',
      ['ne-1', keyset.id],
    );
  });
});

describe('re-enrol tags into a new keyset', () => {
  it('moves the tags without a key of their own, keeps counters, and audits it', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const from = (await made(authority)).keyset;
    const to = (await made(authority)).keyset;
    const a = await tag(t.org.id, from.id, 7);
    const b = await tag(t.org.id, from.id, 9);
    const out = await reenrolTags(ctx(), authority, from.id, to.id);
    expect(out).toMatchObject({ moved: 2, ownKey: 0 });
    const rows = await all<{ keyset_id: string; key_version: number; ctr: number }>(
      db(),
      'SELECT keyset_id, key_version, ctr FROM nfc_tag_sun WHERE tag_id IN (?, ?) ORDER BY ctr',
      [a.id, b.id],
    );
    expect(rows).toEqual([
      { keyset_id: to.id, key_version: 1, ctr: 7 },
      { keyset_id: to.id, key_version: 1, ctr: 9 },
    ]);
    const logged = await audit(from.id, 'tag_keyset.reenrol');
    expect(logged.map((r) => JSON.parse(r.detail))).toEqual([{ to: to.id, toVersion: 1, tags: 2 }]);
    // Nothing left to move: no second audit row.
    expect(await reenrolTags(ctx(), authority, from.id, to.id)).toMatchObject({ moved: 0 });
    expect(await audit(from.id, 'tag_keyset.reenrol')).toHaveLength(1);
  });

  it('works from a disabled keyset: the recovery after a leak', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const from = (await made(authority)).keyset;
    const to = (await made(authority)).keyset;
    const a = await tag(t.org.id, from.id);
    await disableKeyset(ctx(), authority, from.id);
    expect(await reenrolTags(ctx(), authority, from.id, to.id)).toMatchObject({ moved: 1 });
    expect(await first(db(), 'SELECT keyset_id FROM nfc_tag_sun WHERE tag_id = ?', [a.id])).toEqual(
      { keyset_id: to.id },
    );
  });

  it('refuses the same keyset, a disabled or imported target, one with no active key, and another org', async () => {
    const t = await f.org();
    const authority = await t.admin.authority();
    const from = (await made(authority)).keyset;
    const to = (await made(authority)).keyset;
    await refused(reenrolTags(ctx(), authority, from.id, from.id), 'KEYSET_REENROL_SAME');
    const own = await createKeyset(ctx(), authority, {
      name: 'Own',
      perTag: true,
      metaKey: 'ab'.repeat(16),
    });
    await refused(reenrolTags(ctx(), authority, from.id, own.id), 'KEYSET_REENROL_OWN_KEYS');
    await refused(reenrolTags(ctx(), authority, own.id, to.id), 'KEYSET_REENROL_OWN_KEYS');
    await revokeKeyVersion(ctx(), authority, to.id, 1);
    await refused(reenrolTags(ctx(), authority, from.id, to.id), 'KEYSET_NO_ACTIVE_KEY');
    await disableKeyset(ctx(), authority, to.id);
    await refused(reenrolTags(ctx(), authority, from.id, to.id), 'KEYSET_DISABLED');
    const other = await f.org();
    const foreign = (await made(await other.admin.authority())).keyset;
    await refused(reenrolTags(ctx(), authority, from.id, foreign.id), 'KEYSET_NOT_FOUND');
    await refused(
      reenrolTags(ctx(), await other.admin.authority(), from.id, foreign.id),
      'KEYSET_NOT_FOUND',
    );
  });

  it('is held by the database: no move across orgs or modes, onto a per-tag keyset, with a key of its own, or with a new counter', async () => {
    const t = await f.org();
    const other = await f.org();
    const authority = await t.admin.authority();
    const from = (await made(authority)).keyset;
    const sameOrg = (await made(authority)).keyset;
    const foreign = (await made(await other.admin.authority())).keyset;
    const testMode = (await made(await t.admin.authority('test'))).keyset;
    const own = await createKeyset(ctx(), authority, {
      name: 'Own',
      perTag: true,
      metaKey: 'cd'.repeat(16),
    });
    const a = await tag(t.org.id, from.id);
    const move = (to: string, extra = '') =>
      run(db(), `UPDATE nfc_tag_sun SET keyset_id = ?${extra} WHERE tag_id = ?`, [to, a.id]);
    for (const to of [foreign.id, testMode.id, own.id])
      await expect(move(to)).rejects.toThrow('tag_sun_move');
    await expect(move(sameOrg.id, ', ctr = 99')).rejects.toThrow('tag_sun_move');
    await move(sameOrg.id);
  });
});
