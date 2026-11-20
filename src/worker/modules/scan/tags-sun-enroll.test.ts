import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import { type SunKeyset, sunCounter, sunKeyset, sunTap } from './sun-test-fixtures.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: EnrollFixture;
let ks: SunKeyset;
beforeAll(async () => {
  f = await enrollFixture();
  ks = await sunKeyset(f.kit, f.kit.org.id, { diversify: true });
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const uid7 = () =>
  `04${(Math.random() * 2 ** 48).toString(16).replace('.', '').padEnd(12, '0').slice(0, 12)}`;
const row = async (uid: string) => {
  const { ref } = await tagRef(f.kit.env, f.kit.org.id, 'live', uid);
  return first<{ id: string; system: string; ctr: number | null; key_version: number | null }>(
    f.kit.env.DB,
    `SELECT t.id, t.system, s.ctr, s.key_version FROM nfc_tags t LEFT JOIN nfc_tag_sun s ON s.tag_id = t.id
     WHERE t.org_id = ? AND t.mode = 'live' AND t.tag_ref = ?`,
    [f.kit.org.id, ref],
  );
};
const act = async (s: { headers: Record<string, string> }, tag: unknown) =>
  json(
    await f.kit.post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
    }),
  );

describe('enrolling a Secure tag at a scanner', () => {
  it('inspects a new diversified tag, binds it with its counter, and refuses the same read again', async () => {
    const desk = await f.desk();
    const { card, pass } = await f.pass();
    const uid = uid7();
    const tap = await sunTap(ks, uid, 3);
    expect(await json(await f.inspect(desk, tap))).toMatchObject({
      state: 'new',
      assurance: 'secure',
    });
    const preview = await f.bind(desk, { card, tag: tap, preview: true });
    expect(await json(preview)).toMatchObject({ status: 'preview', assurance: 'secure' });
    expect(await row(uid)).toBeNull();

    const idempotencyKey = key();
    const bound = await f.bind(desk, { card, tag: tap, idempotencyKey });
    expect(await json(bound)).toMatchObject({ status: 'bound', assurance: 'secure' });
    expect(await row(uid)).toMatchObject({ system: 'sun', ctr: 3, key_version: 1 });
    // The device's retry of that request answers the stored result, still Secure.
    expect(await json(await f.bind(desk, { card, tag: tap, idempotencyKey }))).toMatchObject({
      status: 'bound',
      assurance: 'secure',
    });
    // Another request with the same read: the read was used.
    const again = await f.bind(desk, { card, tag: tap });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'TAG_CHECK_FAILED' });
    // The next tap is the tag: known, bound, Secure.
    expect(await json(await f.inspect(desk, await sunTap(ks, uid, 4)))).toMatchObject({
      state: 'bound',
      assurance: 'secure',
    });
    const door = await f.door();
    expect(await act(door, await sunTap(ks, uid, 5))).toMatchObject({ kind: 'ok' });
    expect((await row(uid))?.ctr).toBe(5);
    const scanned = await first<{ pass_id: string }>(
      f.kit.env.DB,
      'SELECT pass_id FROM scans WHERE tag_id = ? AND state = ?',
      [(await row(uid))?.id ?? '', 'done'],
    );
    expect(scanned?.pass_id).toBe(pass.id);
  });

  it('refuses an unknown keyset and a bad MAC, and stores nothing', async () => {
    const desk = await f.desk();
    const { card } = await f.pass();
    const uid = uid7();
    const before = await f.count('SELECT count(*) AS n FROM nfc_tags');
    const reads = [
      await sunTap(ks, uid, 1, { slug: 'nosuchky' }),
      await sunTap(ks, uid, 1, { m: '0000000000000000' }),
    ];
    for (const tag of reads) {
      expect(await json(await f.inspect(desk, tag))).toMatchObject({ state: 'invalid' });
      expect(await json(await f.bind(desk, { card, tag }))).toMatchObject({
        code: 'TAG_CHECK_FAILED',
      });
    }
    expect(await f.count('SELECT count(*) AS n FROM nfc_tags')).toBe(before);
  });

  it('never opens a Secure tag by its UID: inspect, assign and a typed assign refuse it', async () => {
    const desk = await f.desk();
    const { card, pass } = await f.pass();
    const uid = uid7();
    expect((await f.bind(desk, { card, tag: await sunTap(ks, uid, 1) })).status).toBe(200);
    const uidOnly = { uid, tech: 'a' as const, source: 'native' as const };
    expect(await json(await f.inspect(desk, uidOnly))).toMatchObject({ state: 'invalid' });
    const otherPass = await f.pass();
    const res = await f.bind(desk, { card: otherPass.card, tag: uidOnly });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAG_CHECK_FAILED' });
    const active = await f.active();
    expect(active.filter((b) => b.pass_id === pass.id)).toHaveLength(1);
    expect(
      active.filter((b) => b.pass_id !== pass.id && b.pass_id === otherPass.pass.id),
    ).toHaveLength(0);
  });

  it('reads a SUN URL on another host as the tag UID alone: a Basic tag, never Secure', async () => {
    const desk = await f.desk();
    const uid = uid7();
    const tag = await sunTap(ks, uid, 1, { host: 'evil.example' });
    expect(await json(await f.inspect(desk, tag))).toMatchObject({
      state: 'new',
      assurance: 'basic',
    });
  });

  it('enrols a Secure tag for a remote request, once', async () => {
    const scanner = await f.device('desk');
    const socket = await f.connect(scanner.id);
    const { pass } = await f.pass();
    const made = await f.nfc(f.operator.headers, 'POST', `/passes/${pass.id}/enrollments`, {
      scannerId: scanner.id,
      binding: 'pass',
    });
    expect(made.status).toBe(200);
    const e = (await made.json()) as { id: string };
    const uid = uid7();
    const tap = await sunTap(ks, uid, 8);
    const done = await f.kit.post(scanner.headers, `/tag-enrollments/${e.id}/complete`, {
      tag: tap,
    });
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await row(uid)).toMatchObject({ system: 'sun', ctr: 8 });
    // A second request cannot reuse the read.
    const second = await f.nfc(
      f.operator.headers,
      'POST',
      `/passes/${(await f.pass()).pass.id}/enrollments`,
      {
        scannerId: scanner.id,
        binding: 'pass',
      },
    );
    const e2 = (await second.json()) as { id: string };
    const again = await f.kit.post(scanner.headers, `/tag-enrollments/${e2.id}/complete`, {
      tag: tap,
    });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'TAG_CHECK_FAILED' });
    expect((await row(uid))?.ctr).toBe(8);
    socket.socket.close(1000);
  });

  it('lets two scanners enrol one new tag with one read: one wins', async () => {
    const a = await f.desk();
    const b = await f.desk();
    const pa = await f.pass();
    const pb = await f.pass();
    const uid = uid7();
    const tap = await sunTap(ks, uid, 2);
    const answers = await Promise.all([
      f.bind(a, { card: pa.card, tag: tap }),
      f.bind(b, { card: pb.card, tag: tap }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await sunCounter(f.kit, (await row(uid))?.id ?? '')).toBe(2);
    const bindings = await f.count(
      'SELECT count(*) AS n FROM tag_bindings WHERE tag_id = ? AND ended_at IS NULL',
      [(await row(uid))?.id ?? ''],
    );
    expect(bindings).toBe(1);
  });

  it('never lets a Basic tag row be read as Secure, and a Secure read take a pass that needs it', async () => {
    const desk = await f.desk();
    const uid = uid7();
    const { card } = await f.pass();
    expect((await f.bind(desk, { card, tag: f.read(uid) })).status).toBe(200);
    const tap = await sunTap(ks, uid, 9);
    expect(await json(await f.inspect(desk, tap))).toMatchObject({ state: 'invalid' });
    const other = await f.pass();
    expect(await json(await f.bind(desk, { card: other.card, tag: tap }))).toMatchObject({
      code: 'TAG_CHECK_FAILED',
    });
    expect((await row(uid))?.system).toBe('uid');
  });

  it('takes a Secure tag on a pass whose template needs one, and opens the door with it', async () => {
    const secure = await f.kit.scanTemplate('Staff badge', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      tags: { min: 'secure' },
    });
    const desk = await f.desk({ templateIds: [f.tpl, secure] });
    const { card } = await f.pass({ template: secure });
    const uid = uid7();
    expect(await json(await f.bind(desk, { card, tag: f.read(uid) }))).toMatchObject({
      code: 'TAG_ASSURANCE_LOW',
    });
    const bound = await f.bind(desk, { card, tag: await sunTap(ks, uid, 1) });
    expect(await json(bound)).toMatchObject({ status: 'bound', assurance: 'secure' });
    const door = await f.door({ templateIds: [secure] });
    expect(await act(door, await sunTap(ks, uid, 2))).toMatchObject({ kind: 'ok' });
  });
});
