import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { createKeyset, rotateKeyset } from '../nfc/keysets.ts';
import { reenrolTags, revokeKeyVersion } from '../nfc/keysets-recover.ts';
import { hexToBytes } from '../nfc/sun.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import {
  addKeyVersion,
  enrolledSunTag,
  keysetAdmin,
  type SunKeyset,
  sunKeyset,
  sunTap,
} from './sun-test-fixtures.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const random = () => crypto.getRandomValues(new Uint8Array(16));
const hex = (v: Uint8Array) => Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
let n = 0;
const uid7 = () => `04ee${(++n).toString(16).padStart(10, '0')}`;
const act = async (s: { headers: Record<string, string> }, tag: unknown) =>
  json(
    await f.kit.post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
    }),
  );
const sideRow = (uid: string) =>
  tagRef(f.kit.env, f.kit.org.id, 'live', uid).then(({ ref }) =>
    first<{ keyset_id: string; key_version: number; ctr: number }>(
      f.kit.env.DB,
      `SELECT s.keyset_id, s.key_version, s.ctr FROM nfc_tags t JOIN nfc_tag_sun s ON s.tag_id = t.id
       WHERE t.org_id = ? AND t.mode = 'live' AND t.tag_ref = ?`,
      [f.kit.org.id, ref],
    ),
  );
const tagRows = async (uid: string) =>
  first<{ n: number }>(
    f.kit.env.DB,
    'SELECT count(*) AS n FROM nfc_tags WHERE org_id = ? AND tag_ref = ?',
    [f.kit.org.id, (await tagRef(f.kit.env, f.kit.org.id, 'live', uid)).ref],
  ).then((r) => r?.n);

describe('a retiring key version', () => {
  it('opens the tags it has and enrols no new one; the active version enrols', async () => {
    const v1 = await sunKeyset(f.kit, f.kit.org.id);
    const { pass } = await f.pass();
    const known = uid7();
    await enrolledSunTag(f.kit, v1, known, pass, 5);
    await run(f.kit.env.DB, "UPDATE nfc_tag_keys SET state = 'retiring' WHERE keyset_id = ?", [
      v1.id,
    ]);
    const v2 = { ...v1, meta: random(), file: random() };
    await addKeyVersion(f.kit, v1, 2, v2.meta, v2.file);

    const door = await f.door();
    expect(await act(door, await sunTap(v1, known, 6))).toMatchObject({ kind: 'ok' });

    const desk = await f.desk();
    const { card } = await f.pass();
    const fresh = uid7();
    const old = await sunTap(v1, fresh, 1);
    expect(await json(await f.inspect(desk, old))).toMatchObject({ state: 'invalid' });
    const refused = await f.bind(desk, { card, tag: old });
    expect([refused.status, (await json(refused)).code]).toEqual([409, 'TAG_CHECK_FAILED']);
    expect(await tagRows(fresh)).toBe(0);
    const bound = await f.bind(desk, { card, tag: await sunTap(v2, fresh, 2) });
    expect(await json(bound)).toMatchObject({ status: 'bound', assurance: 'secure' });
    expect(await sideRow(fresh)).toMatchObject({ key_version: 2, ctr: 2 });
  });
});

describe('revoke a version, tags on it must be written again', () => {
  it('refuses them at the door until a newer version’s keys are on the tag, then they move up', async () => {
    const admin = await keysetAdmin(f.kit, f.kit.org.id);
    const m1 = random();
    const f1 = random();
    const made = await createKeyset(f.kit.ctx, admin, {
      name: 'Leaky',
      diversify: false,
      metaKey: hex(m1),
      fileKey: hex(f1),
    });
    const v1 = { slug: made.slug, meta: m1, file: f1, diversify: false };
    const { pass } = await f.pass();
    const uid = uid7();
    await enrolledSunTag(
      f.kit,
      { ...v1, id: made.id, orgId: f.kit.org.id, mode: 'live', perTag: false } as SunKeyset,
      uid,
      pass,
      5,
    );
    const door = await f.door();
    expect(await act(door, await sunTap(v1, uid, 6))).toMatchObject({ kind: 'ok' });

    const rotated = await rotateKeyset(f.kit.ctx, admin, made.id, { generate: true });
    const v2 = {
      slug: made.slug,
      meta: hexToBytes(rotated.keys?.metaKey ?? '') as Uint8Array,
      file: hexToBytes(rotated.keys?.fileKey ?? '') as Uint8Array,
      diversify: false,
    };
    // Rotated: the old keys still open it (a second check-in answers a heads-up).
    expect(await act(door, await sunTap(v1, uid, 7))).not.toMatchObject({ kind: 'refused' });
    await revokeKeyVersion(f.kit.ctx, admin, made.id, 1);
    expect(await act(door, await sunTap(v1, uid, 8))).toMatchObject({ reason: 'tag_invalid' });
    expect(await sideRow(uid)).toMatchObject({ key_version: 1, ctr: 7 });
    // Written with the new keys: it opens, and moves up.
    expect(await act(door, await sunTap(v2, uid, 9))).not.toMatchObject({ kind: 'refused' });
    expect(await sideRow(uid)).toMatchObject({ key_version: 2, ctr: 9 });
  });
});

describe('re-enrol after a leak', () => {
  it('keeps the tag, its pass and its counter; it opens again only with the new keyset’s keys', async () => {
    const admin = await keysetAdmin(f.kit, f.kit.org.id);
    const a = await sunKeyset(f.kit, f.kit.org.id, { diversify: true });
    const { pass } = await f.pass();
    const uid = uid7();
    await enrolledSunTag(f.kit, a, uid, pass, 5);
    const door = await f.door();
    expect(await act(door, await sunTap(a, uid, 6))).toMatchObject({ kind: 'ok' });

    const mf = random();
    const mm = random();
    const made = await createKeyset(f.kit.ctx, admin, {
      name: 'After the leak',
      diversify: true,
      metaKey: hex(mm),
      fileKey: hex(mf),
    });
    const b = { slug: made.slug, meta: mm, file: mf, diversify: true };
    // Before the move the new keys name a keyset the tag is not on.
    expect(await act(door, await sunTap(b, uid, 7))).toMatchObject({ reason: 'tag_invalid' });
    await run(f.kit.env.DB, 'UPDATE nfc_tag_keysets SET disabled_at = 1 WHERE id = ?', [a.id]);
    expect(await reenrolTags(f.kit.ctx, admin, a.id, made.id)).toMatchObject({
      moved: 1,
      ownKey: 0,
    });
    expect(await sideRow(uid)).toMatchObject({ keyset_id: made.id, key_version: 1, ctr: 6 });
    // The leaked keys are dead, the new ones open the same tag and its binding.
    expect(await act(door, await sunTap(a, uid, 8))).toMatchObject({ reason: 'tag_invalid' });
    expect(await act(door, await sunTap(b, uid, 9))).not.toMatchObject({ kind: 'refused' });
    expect(await sideRow(uid)).toMatchObject({ keyset_id: made.id, ctr: 9 });
    const scanned = await first<{ pass_id: string }>(
      f.kit.env.DB,
      "SELECT s.pass_id FROM scans s JOIN nfc_tags t ON t.id = s.tag_id WHERE t.tag_ref = ? AND s.state = 'done' ORDER BY s.at DESC LIMIT 1",
      [(await tagRef(f.kit.env, f.kit.org.id, 'live', uid)).ref],
    );
    expect(scanned?.pass_id).toBe(pass.id);
  });
});
