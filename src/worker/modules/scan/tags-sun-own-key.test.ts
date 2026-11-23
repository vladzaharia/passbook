import { beforeAll, describe, expect, it } from 'vitest';
import { loadKekRing } from '../../platform/crypto.ts';
import { first, run } from '../../platform/db.ts';
import { importTags } from '../nfc/import.ts';
import { sealTagKey } from '../nfc/keyset-seal.ts';
import { createKeyset } from '../nfc/keysets.ts';
import { hexToBytes } from '../nfc/sun.ts';
import { verifySunTap } from '../nfc/systems/sun.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import {
  enrolledSunTag,
  keysetAdmin,
  sunCounter,
  sunKeyset,
  sunTap,
  ZERO,
} from './sun-test-fixtures.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: EnrollFixture;
beforeAll(async () => {
  f = await enrollFixture();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const h = (hex: string) => hexToBytes(hex) as Uint8Array;
const random = () => crypto.getRandomValues(new Uint8Array(16));
const act = async (s: { headers: Record<string, string> }, tag: unknown) =>
  json(
    await f.kit.post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
    }),
  );
// NXP AN12196 SDM example, all-zero keys: UID 04DE5F1EACC040, read counter 61.
const AN = { uid: '04de5f1eacc040', p: 'EF963FF7828658A599F3041510671E88', m: '94EED9EE65337086' };
const anRead = (slug: string) => ({
  tech: 'isodep' as const,
  source: 'native' as const,
  ndef: { type: 'U' as const, value: `https://passbook.mobile/t/${slug}?p=${AN.p}&m=${AN.m}` },
});
/** AN12196 is the only vector with a known key, so these keysets keep their own zero key out of the way. */
const perTagKeyset = () =>
  sunKeyset(f.kit, f.kit.org.id, { perTag: true, meta: ZERO, file: random() });

describe('a tag with its own file key: NXP AN12196 vectors', () => {
  it('verifies the published tap with the tag key, and a replay is refused', async () => {
    const ks = await perTagKeyset();
    const { pass } = await f.pass();
    const t = await enrolledSunTag(f.kit, ks, AN.uid, pass, 60, ZERO);
    const door = await f.door();
    const read = anRead(ks.slug);
    expect(await act(door, read)).toMatchObject({ kind: 'ok' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(61);
    expect(await act(door, read)).toMatchObject({ kind: 'refused', reason: 'tag_invalid' });
  });

  it('refuses it when the tag holds another key, though the keyset key would verify: no fallback', async () => {
    // The keyset's own key is the AN12196 zero key: it would pass if it were ever tried.
    const ks = await sunKeyset(f.kit, f.kit.org.id, {
      mode: 'test',
      perTag: true,
      meta: ZERO,
      file: ZERO,
    });
    const { ref, hint } = await tagRef(f.kit.env, f.kit.org.id, 'test', AN.uid);
    const db = f.kit.env.DB;
    await run(
      db,
      "INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, created_at) VALUES ('own-1', ?, 'test', ?, 'sun', ?, 1)",
      [f.kit.org.id, ref, hint],
    );
    const e = await sealTagKey(
      await loadKekRing(f.kit.env),
      { orgId: f.kit.org.id, mode: 'test', keysetId: ks.id },
      'own-1',
      h('0123456789abcdef0123456789abcdef'),
    );
    await run(
      db,
      `INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, kek_version, iv, wrapped_dek, ciphertext, ctr, ctr_at)
       VALUES ('own-1', ?, 1, ?, ?, ?, ?, 60, 1)`,
      [ks.id, e.kekVersion, e.iv, e.wrappedDek, e.ciphertext],
    );
    const res = await verifySunTap(f.kit.ctx, f.kit.org.id, 'test', anRead(ks.slug));
    expect(res).toMatchObject({ ok: false, code: 'TAG_SUN_VERIFY' });
  });

  it('refuses a tag it holds no key for, though the keyset key would verify', async () => {
    const ks = await sunKeyset(f.kit, f.kit.org.id, { perTag: true, meta: ZERO, file: ZERO });
    const res = await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', anRead(ks.slug));
    expect(res).toMatchObject({ ok: false, code: 'TAG_SUN_VERIFY', reason: 'tag_invalid' });
    const desk = await f.desk();
    expect(await json(await f.inspect(desk, anRead(ks.slug)))).toMatchObject({ state: 'invalid' });
  });
});

describe('imported tags, end to end', () => {
  it('imports, assigns at a desk, opens a door, and each tag verifies with its own key only', async () => {
    const admin = await keysetAdmin(f.kit, f.kit.org.id);
    const meta = 'c3'.repeat(16);
    const made = await createKeyset(f.kit.ctx, admin, {
      name: 'Supplier',
      perTag: true,
      metaKey: meta,
    });
    const keyA = '00112233445566778899aabbccddeeff';
    const keyB = 'ffeeddccbbaa99887766554433221100';
    const csv = `uid,key\n04aa00000000a1,${keyA}\n04aa00000000b2,${keyB}\n`;
    expect(await importTags(f.kit.ctx, admin, made.id, { csv, dryRun: false })).toMatchObject({
      added: 2,
      problems: [],
    });
    const ks = { slug: made.slug, meta: h(meta), file: random(), diversify: false };
    const { ref } = await tagRef(f.kit.env, f.kit.org.id, 'live', '04aa00000000a1');
    const spare = await first<{ id: string; ctr: number; system: string }>(
      f.kit.env.DB,
      `SELECT t.id, s.ctr, t.system FROM nfc_tags t JOIN nfc_tag_sun s ON s.tag_id = t.id WHERE t.tag_ref = ?`,
      [ref],
    );
    expect(spare).toMatchObject({ ctr: 0, system: 'sun' });

    const desk = await f.desk();
    const { card, pass } = await f.pass();
    // Another tag's key does not do.
    const wrong = await sunTap(ks, '04aa00000000a1', 1, { tagKey: h(keyB) });
    expect(await json(await f.inspect(desk, wrong))).toMatchObject({ state: 'invalid' });
    const tap = await sunTap(ks, '04aa00000000a1', 2, { tagKey: h(keyA) });
    expect(await json(await f.bind(desk, { card, tag: tap }))).toMatchObject({
      status: 'bound',
      assurance: 'secure',
    });
    expect(await sunCounter(f.kit, spare?.id ?? '')).toBe(2);
    const door = await f.door();
    const next = await sunTap(ks, '04aa00000000a1', 3, { tagKey: h(keyA) });
    expect(await act(door, next)).toMatchObject({ kind: 'ok' });
    expect(await act(door, next)).toMatchObject({ reason: 'tag_invalid' });
    const scanned = await first<{ pass_id: string }>(
      f.kit.env.DB,
      "SELECT pass_id FROM scans WHERE tag_id = ? AND state = 'done'",
      [spare?.id ?? ''],
    );
    expect(scanned?.pass_id).toBe(pass.id);
  });
});
