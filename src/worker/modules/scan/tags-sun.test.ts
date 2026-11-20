import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { sunStale, verifySunTap } from '../nfc/systems/sun.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import {
  addKeyVersion,
  enrolledSunTag,
  type SunKeyset,
  sunCounter,
  sunKeyset,
  sunTap,
  ZERO,
} from './sun-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
let ks: SunKeyset;
beforeAll(async () => {
  f = await tagScanFixture();
  ks = await sunKeyset(f.kit, f.kit.org.id);
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const input = (tag: unknown) => ({ tag, method: 'nfc' });
const act = (s: { headers: Record<string, string> }, tag: unknown, over = {}) =>
  f.kit
    .post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: input(tag),
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
      ...over,
    })
    .then(json);
const resolve = (s: { headers: Record<string, string> }, tag: unknown) =>
  f.kit
    .post(s.headers, '/resolve', {
      idempotencyKey: key(),
      input: input(tag),
      clientTs: f.kit.clock.now(),
    })
    .then(json);
/** A org holds four live keysets per mode: tests that make more disable theirs when done. */
const retire = (...sets: SunKeyset[]) =>
  Promise.all(
    sets.map((k) =>
      run(f.kit.env.DB, 'UPDATE nfc_tag_keysets SET disabled_at = 1 WHERE id = ?', [k.id]),
    ),
  );
const uid7 = () =>
  `04${(Math.random() * 2 ** 48).toString(16).replace('.', '').padEnd(12, '0').slice(0, 12)}`;

/** A pass with a Secure tag enrolled at counter `ctr`, and a door. */
async function setup(keyset: SunKeyset = ks, ctr = 5) {
  const { pass } = await f.pass();
  const uid = uid7();
  const tag = await enrolledSunTag(f.kit, keyset, uid, pass, ctr);
  return { pass, uid, ...tag, door: await f.door() };
}

describe('the SUN plugin, NXP AN12196 vectors', () => {
  it('verifies the published tap and reads the counter and UID from it', async () => {
    const an = await sunKeyset(f.kit, f.kit.org.id, { meta: ZERO, file: ZERO });
    const read = {
      uid: '04de5f1eacc040',
      tech: 'isodep' as const,
      source: 'native' as const,
      ndef: {
        type: 'U' as const,
        value: `https://passbook.mobile/t/${an.slug}?p=EF963FF7828658A599F3041510671E88&m=94EED9EE65337086`,
      },
    };
    const res = await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', read);
    const { ref } = await tagRef(f.kit.env, f.kit.org.id, 'live', '04de5f1eacc040');
    expect(res).toEqual({
      ok: true,
      proof: {
        ref,
        hint: ref.slice(0, 4).toUpperCase(),
        keysetId: an.id,
        slug: an.slug,
        keyVersion: 1,
        ctr: 61,
      },
    });
    // The URL names the keyset; the reader's own UID is ignored.
    const other = await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', {
      ...read,
      uid: '04aaaaaaaaaaaa',
    });
    expect(other).toEqual(res);
    await retire(an);
  });

  it('opens a door with the tap, once', async () => {
    const an = await sunKeyset(f.kit, f.kit.org.id, { meta: ZERO, file: ZERO });
    const { pass } = await f.pass();
    const t = await enrolledSunTag(f.kit, an, '04de5f1eacc040', pass, 60);
    const door = await f.door();
    const read = {
      tech: 'isodep' as const,
      source: 'native' as const,
      ndef: {
        type: 'U' as const,
        value: `https://passbook.mobile/t/${an.slug}?p=EF963FF7828658A599F3041510671E88&m=94EED9EE65337086`,
      },
    };
    expect(await act(door, read)).toMatchObject({ kind: 'ok' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(61);
    expect(await act(door, read)).toMatchObject({ kind: 'refused', reason: 'tag_invalid' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(61);
    await retire(an);
  });
});

describe('a SUN read at the door', () => {
  it('resolves without using the read, and act uses it', async () => {
    const t = await setup();
    const tap = await sunTap(ks, t.uid, 6);
    expect(await resolve(t.door, tap)).toMatchObject({ kind: 'ready' });
    expect(await resolve(t.door, tap)).toMatchObject({ kind: 'ready' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(5);
    expect(await act(t.door, tap)).toMatchObject({ kind: 'ok' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(6);
    expect(await resolve(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
  });

  it('refuses a replayed read at act, records it against the tag, and keeps the counter', async () => {
    const t = await setup();
    const tap = await sunTap(ks, t.uid, 9);
    expect(await act(t.door, tap)).toMatchObject({ kind: 'ok' });
    const again = await act(t.door, tap);
    expect(again).toMatchObject({ kind: 'refused', reason: 'tag_invalid', card: null });
    expect(await sunCounter(f.kit, t.tagId)).toBe(9);
    const refusals = await first<{ n: number }>(
      f.kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE tag_id = ? AND reason = 'tag_invalid'",
      [t.tagId],
    );
    expect(refusals?.n).toBe(1);
    // An older read is no better.
    expect(await act(t.door, await sunTap(ks, t.uid, 8))).toMatchObject({ reason: 'tag_invalid' });
    // A newer read is used (the door's own answer is a second check-in's heads-up).
    expect(await act(t.door, await sunTap(ks, t.uid, 10))).not.toMatchObject({
      reason: 'tag_invalid',
    });
    expect(await sunCounter(f.kit, t.tagId)).toBe(10);
  });

  it('answers a retry of the same request with the stored answer, not a replay refusal', async () => {
    const t = await setup();
    const tap = await sunTap(ks, t.uid, 7);
    const idempotencyKey = key();
    const first = await act(t.door, tap, { idempotencyKey });
    expect(first).toMatchObject({ kind: 'ok' });
    expect(await act(t.door, tap, { idempotencyKey })).toMatchObject({ kind: 'ok', replay: true });
    expect(await sunCounter(f.kit, t.tagId)).toBe(7);
  });

  it('lets exactly one of two concurrent acts on one read win', async () => {
    const t = await setup();
    const tap = await sunTap(ks, t.uid, 12);
    const answers = await Promise.all([act(t.door, tap), act(t.door, tap), act(t.door, tap)]);
    expect(answers.filter((a) => a.kind === 'ok')).toHaveLength(1);
    expect(answers.filter((a) => a.reason === 'tag_invalid')).toHaveLength(2);
    expect(await sunCounter(f.kit, t.tagId)).toBe(12);
    const ok = await first<{ n: number }>(
      f.kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE tag_id = ? AND state = 'done' AND outcome = 'ok'",
      [t.tagId],
    );
    expect(ok?.n).toBe(1);
    // The losers are on the tag's record, as a sequential replay is.
    const lost = await first<{ n: number }>(
      f.kit.env.DB,
      "SELECT count(*) AS n FROM scans WHERE tag_id = ? AND reason = 'tag_invalid'",
      [t.tagId],
    );
    expect(lost?.n).toBe(2);
  });

  it('refuses a refused tag read too, and uses the read up', async () => {
    const t = await setup();
    await run(f.kit.env.DB, "UPDATE nfc_tags SET lost_at = 1, lost_by = 'a' WHERE id = ?", [
      t.tagId,
    ]);
    const tap = await sunTap(ks, t.uid, 20);
    expect(await act(t.door, tap)).toMatchObject({ reason: 'tag_lost' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(20);
    expect(await act(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
  });

  it('refuses a read with a wrong host or slug, and a UID-only read of a Secure tag', async () => {
    const t = await setup();
    const other = await sunKeyset(f.kit, f.kit.org.id);
    const reads = [
      await sunTap(ks, t.uid, 30, { host: 'evil.example' }),
      await sunTap(ks, t.uid, 30, { host: 'passbook.mobile.evil.example' }),
      await sunTap(ks, t.uid, 30, { slug: other.slug }),
      await sunTap(ks, t.uid, 30, { slug: 'nosuchky' }),
      { uid: t.uid, tech: 'a' as const, source: 'native' as const },
      {
        uid: t.uid,
        tech: 'a' as const,
        source: 'native' as const,
        ndef: { type: 'T' as const, value: 'x' },
      },
    ];
    for (const tap of reads) {
      expect(await resolve(t.door, tap)).toMatchObject({ kind: 'refused', reason: 'tag_invalid' });
      expect(await act(t.door, tap)).toMatchObject({ kind: 'refused', reason: 'tag_invalid' });
    }
    expect(await sunCounter(f.kit, t.tagId)).toBe(5);
    // The right read still works: none of the above used the counter.
    expect(await act(t.door, await sunTap(ks, t.uid, 30))).toMatchObject({ kind: 'ok' });
    await retire(other);
  });

  it('refuses a flipped MAC or PICC and a tap made with other keys', async () => {
    const t = await setup();
    const good = await sunTap(ks, t.uid, 40);
    const url = new URL(good.ndef.value);
    const flip = (v: string) => `${v.slice(0, -1)}${v.endsWith('0') ? '1' : '0'}`;
    const bad = [
      await sunTap(ks, t.uid, 40, { m: flip(url.searchParams.get('m') ?? '') }),
      await sunTap(ks, t.uid, 40, { p: flip(url.searchParams.get('p') ?? '') }),
      await sunTap({ ...ks, file: crypto.getRandomValues(new Uint8Array(16)) }, t.uid, 40),
      await sunTap({ ...ks, meta: crypto.getRandomValues(new Uint8Array(16)) }, t.uid, 40),
    ];
    for (const tap of bad) expect(await act(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
    expect(await sunCounter(f.kit, t.tagId)).toBe(5);
  });

  it('refuses a tap of a UID the tag does not have: the UID comes from the decrypted read', async () => {
    const t = await setup();
    const mine = await setup();
    // A read of `mine` carrying `t`'s UID in the reader field is still `mine`'s tag.
    const tap = { ...(await sunTap(ks, mine.uid, 50)), uid: t.uid };
    expect(await act(t.door, tap)).toMatchObject({ kind: 'ok' });
    expect(await sunCounter(f.kit, mine.tagId)).toBe(50);
    expect(await sunCounter(f.kit, t.tagId)).toBe(5);
  });
});

describe('keysets and keys', () => {
  it('refuses another org keyset, however valid its keys', async () => {
    const other = await makeOrg(f.kit.fx);
    const foreign = await sunKeyset(f.kit, other.id);
    const t = await setup();
    const tap = await sunTap(foreign, t.uid, 60);
    expect(await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', tap)).toMatchObject({
      ok: false,
      code: 'TAG_SUN_KEYSET',
      reason: 'tag_invalid',
    });
    expect(await act(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
    const desk = await f.desk();
    expect(await json(await f.inspect(desk, tap))).toMatchObject({ state: 'invalid' });
    const { card } = await f.pass();
    const bind = await f.bind(desk, { card, tag: await sunTap(foreign, uid7(), 1) });
    expect(await json(bind)).toMatchObject({ code: 'TAG_CHECK_FAILED' });
    expect(
      await f.count('SELECT count(*) AS n FROM nfc_tags WHERE system = ?', ['sun']),
    ).toBeGreaterThan(0);
    expect(await sunCounter(f.kit, t.tagId)).toBe(5);
  });

  it("answers the other mode's keyset as a test or live pass", async () => {
    const test = await sunKeyset(f.kit, f.kit.org.id, { mode: 'test' });
    const t = await setup();
    const tap = await sunTap(test, t.uid, 61);
    expect(await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', tap)).toMatchObject({
      ok: false,
      code: 'TAG_SUN_MODE',
      reason: 'test_pass',
    });
    expect(await act(t.door, tap)).toMatchObject({ reason: 'test_pass' });
    expect(await verifySunTap(f.kit.ctx, f.kit.org.id, 'test', tap)).toMatchObject({ ok: true });
    expect(
      await verifySunTap(f.kit.ctx, f.kit.org.id, 'test', await sunTap(ks, t.uid, 61)),
    ).toMatchObject({ ok: false, code: 'TAG_SUN_MODE', reason: 'live_pass' });
    await retire(test);
  });

  it('refuses a disabled keyset', async () => {
    const dead = await sunKeyset(f.kit, f.kit.org.id);
    const t = await setup(dead);
    const tap = await sunTap(dead, t.uid, 70);
    expect(await resolve(t.door, tap)).toMatchObject({ kind: 'ready' });
    await run(f.kit.env.DB, 'UPDATE nfc_tag_keysets SET disabled_at = 1 WHERE id = ?', [dead.id]);
    expect(await resolve(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
    expect(await act(t.door, tap)).toMatchObject({ reason: 'tag_invalid' });
  });

  it('verifies with the retiring key until it is retired, and never lets a tag go back a version', async () => {
    const rot = await sunKeyset(f.kit, f.kit.org.id);
    const t = await setup(rot);
    await run(
      f.kit.env.DB,
      "UPDATE nfc_tag_keys SET state = 'retiring', state_at = 1 WHERE keyset_id = ?",
      [rot.id],
    );
    const next = {
      ...rot,
      meta: crypto.getRandomValues(new Uint8Array(16)),
      file: crypto.getRandomValues(new Uint8Array(16)),
    };
    await addKeyVersion(f.kit, rot, 2, next.meta, next.file);
    expect(await act(t.door, await sunTap(rot, t.uid, 80))).toMatchObject({ kind: 'ok' });
    expect(await act(t.door, await sunTap(next, t.uid, 81))).not.toMatchObject({
      reason: 'tag_invalid',
    });
    const row = await first<{ key_version: number }>(
      f.kit.env.DB,
      'SELECT key_version FROM nfc_tag_sun WHERE tag_id = ?',
      [t.tagId],
    );
    expect(row?.key_version).toBe(2);
    // The old key still verifies, but a tag that moved to version 2 does not go back.
    expect(await act(t.door, await sunTap(rot, t.uid, 82))).toMatchObject({
      reason: 'tag_invalid',
    });
    expect(await sunCounter(f.kit, t.tagId)).toBe(81);
    // Retired: no tag uses version 1 on a fresh keyset, so it can be retired and no longer verifies.
    const fresh = await sunKeyset(f.kit, f.kit.org.id);
    await run(
      f.kit.env.DB,
      "UPDATE nfc_tag_keys SET state = 'retiring', state_at = 1 WHERE keyset_id = ?",
      [fresh.id],
    );
    await addKeyVersion(f.kit, fresh, 2, next.meta, next.file);
    await run(
      f.kit.env.DB,
      "UPDATE nfc_tag_keys SET state = 'retired', state_at = 2 WHERE keyset_id = ? AND version = 1",
      [fresh.id],
    );
    expect(
      await verifySunTap(f.kit.ctx, f.kit.org.id, 'live', await sunTap(fresh, uid7(), 1)),
    ).toMatchObject({ ok: false, code: 'TAG_SUN_VERIFY' });
    await retire(rot, fresh);
  });

  it('logs a gap and refuses a tag on another keyset', () => {
    const logs: unknown[] = [];
    const ctx = { ...f.kit.ctx, log: { info: (...a: unknown[]) => logs.push(a) } } as never;
    const proof = { ref: 'r', hint: 'RRRR', keysetId: 'k', slug: 's', keyVersion: 1, ctr: 2000 };
    const stored = { tagId: 't', system: 'sun', keysetId: 'k', keyVersion: 1, ctr: 5 };
    expect(sunStale(ctx, 'o', proof, stored)).toBeNull();
    expect(JSON.stringify(logs)).toContain('TAG_SUN_GAP');
    expect(sunStale(ctx, 'o', { ...proof, keysetId: 'x' }, stored)).toBe('TAG_SUN_KEYSET');
    expect(sunStale(ctx, 'o', { ...proof, ctr: 5 }, stored)).toBe('TAG_SUN_REPLAY');
    expect(sunStale(ctx, 'o', proof, null)).toBeNull();
  });
});
