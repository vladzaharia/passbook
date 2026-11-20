import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { requestHashOf } from './act-claim.ts';
import {
  enrolledSunTag,
  type SunKeyset,
  sunCounter,
  sunKeyset,
  sunTap,
} from './sun-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { noteSunFailure } from './tags-sun.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
let ks: SunKeyset;
beforeAll(async () => {
  f = await tagScanFixture();
  ks = await sunKeyset(f.kit, f.kit.org.id);
});

type Door = { headers: Record<string, string> };
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const act = (s: Door, tag: unknown, over: Record<string, unknown> = {}) =>
  f.kit
    .post(s.headers, '/actions', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
      ...over,
    })
    .then(json);
const resolve = (s: Door, tag: unknown) =>
  f.kit
    .post(s.headers, '/resolve', {
      idempotencyKey: key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
    })
    .then(json);
const uid7 = () =>
  `04${(Math.random() * 2 ** 48).toString(16).replace('.', '').padEnd(12, '0').slice(0, 12)}`;
const refused = { reason: 'tag_invalid' };

const letInDoor = () =>
  f.kit.scanner({
    templateIds: [f.tpl],
    settings: { roleWithoutSignIn: 'door', letInAgain: 'anyone' },
  });

/** A Secure tag at counter 5 on a pass, a door, and a heads-up on it (a second check-in at counter 7). */
async function headsUp() {
  const { pass } = await f.pass();
  const uid = uid7();
  const tag = await enrolledSunTag(f.kit, ks, uid, pass, 5);
  const door = await letInDoor();
  expect(await act(door, await sunTap(ks, uid, 6))).toMatchObject({ kind: 'ok' });
  const tap = await sunTap(ks, uid, 7);
  const first = await act(door, tap);
  expect(first).toMatchObject({ kind: 'heads_up' });
  return { uid, tag, door, tap, scanId: first.scanId as string };
}

describe('a staffed door follows up a Secure heads-up', () => {
  it('lets in again with the read its heads-up used, once, and never for another scan or device', async () => {
    const t = await headsUp();
    const other = await letInDoor();
    // Never skipped: another device, another scan id, and no heads-up at all are refused.
    expect(await act(other, t.tap, { overrideOf: t.scanId })).toMatchObject(refused);
    expect(await act(t.door, t.tap, { overrideOf: 'not-that-scan' })).toMatchObject(refused);
    expect(await sunCounter(f.kit, t.tag.tagId)).toBe(7);

    const again = await act(t.door, t.tap, { overrideOf: t.scanId });
    expect(again).toMatchObject({ kind: 'ok' });
    // The counter did not move, and the read is spent.
    expect(await sunCounter(f.kit, t.tag.tagId)).toBe(7);
    // A second override of the same heads-up is turned away (the override is taken, and the read is spent).
    expect(await act(t.door, t.tap, { overrideOf: t.scanId })).toMatchObject({
      code: 'SCAN_OVERRIDE_TAKEN',
    });
    expect(await act(t.door, t.tap)).toMatchObject(refused);
    const marked = await first<{ n: number }>(
      f.kit.env.DB,
      'SELECT count(*) AS n FROM scans WHERE id = ? AND sun_followup_at IS NOT NULL',
      [t.scanId],
    );
    expect(marked?.n).toBe(1);
  });

  it('confirms with the same read, once, when the request names no scan', async () => {
    const t = await headsUp();
    expect(await act(t.door, t.tap, { confirmed: true })).not.toMatchObject(refused);
    expect(await act(t.door, t.tap, { confirmed: true })).toMatchObject(refused);
    expect(await sunCounter(f.kit, t.tag.tagId)).toBe(7);
  });

  it('refuses a skimmed copy of a read that opened the door: no heads-up, no follow-up', async () => {
    const { pass } = await f.pass();
    const uid = uid7();
    const tag = await enrolledSunTag(f.kit, ks, uid, pass, 5);
    const door = await letInDoor();
    const tap = await sunTap(ks, uid, 6);
    expect(await act(door, tap)).toMatchObject({ kind: 'ok' });
    expect(await act(door, tap)).toMatchObject(refused);
    expect(await act(door, tap, { confirmed: true })).toMatchObject(refused);
    expect(await sunCounter(f.kit, tag.tagId)).toBe(6);
  });

  it('refuses the old read once a newer tap moved the counter on', async () => {
    const t = await headsUp();
    await act(t.door, await sunTap(ks, t.uid, 8));
    expect(await act(t.door, t.tap, { overrideOf: t.scanId })).toMatchObject(refused);
  });

  it('refuses a follow-up past its window', async () => {
    const t = await headsUp();
    f.kit.clock.advance(6 * 60_000);
    expect(await act(t.door, t.tap, { overrideOf: t.scanId })).toMatchObject(refused);
  });
});

describe('a re-tap that reuses a timed-out key', () => {
  it('reopens the claim and uses up the new tap, not the old one', async () => {
    const { pass } = await f.pass();
    const uid = uid7();
    const tag = await enrolledSunTag(f.kit, ks, uid, pass, 5);
    const door = await letInDoor();
    // A first attempt claimed the key with tap 6 and never finished.
    const body = (read: unknown, idempotencyKey: string) => ({
      idempotencyKey,
      input: { tag: read, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
    });
    const keyed = key();
    const tap6 = await sunTap(ks, uid, 6);
    expect(await act(door, tap6)).toMatchObject({ kind: 'ok' });
    const done = await first<{ actor_key: string; scanner_id: string; actor_id: string }>(
      f.kit.env.DB,
      'SELECT actor_key, scanner_id, actor_id FROM scans WHERE tag_id = ?',
      [tag.tagId],
    );
    const hash = await requestHashOf(body(tap6, keyed) as never, tag.ref);
    await run(
      f.kit.env.DB,
      `INSERT INTO scans (id, org_id, mode, scanner_id, actor_type, actor_id, actor_key, idempotency_key,
         request_hash, method, tag_id, sun_ctr, sun_key_version, state, client_ts, at)
       VALUES (?, ?, 'live', ?, 'scanner', ?, ?, ?, ?, 'nfc', ?, 6, 1, 'pending', 1, ?)`,
      [
        f.kit.fx.ids.id(),
        f.kit.org.id,
        done?.scanner_id ?? '',
        done?.actor_id ?? '',
        done?.actor_key ?? '',
        keyed,
        hash,
        tag.tagId,
        f.kit.clock.now() - 60_000,
      ],
    );
    const tap7 = await sunTap(ks, uid, 7);
    const res = await act(door, tap7, { idempotencyKey: keyed });
    expect(res).not.toMatchObject(refused);
    expect(await sunCounter(f.kit, tag.tagId)).toBe(7);
    const stored = await first<{ sun_ctr: number }>(
      f.kit.env.DB,
      'SELECT sun_ctr FROM scans WHERE idempotency_key = ?',
      [keyed],
    );
    expect(stored?.sun_ctr).toBe(7);
    // The tap the door held is used: nobody else can present it.
    expect(await act(await letInDoor(), tap7)).toMatchObject(refused);
  });
});

describe("a session's Secure-only level", () => {
  it('refuses a Basic tag at act and resolve with tag_not_allowed, and admits a Secure one', async () => {
    const secureDoor = await f.kit.scanner({
      templateIds: [f.tpl],
      settings: { roleWithoutSignIn: 'door', tags: { level: 'secure' } },
    });
    const desk = await f.desk();
    const { card } = await f.pass();
    const basic = f.read();
    expect((await f.bind(desk, { card, tag: basic })).status).toBe(200);
    expect(await resolve(secureDoor, basic)).toMatchObject({ reason: 'tag_not_allowed' });
    expect(await act(secureDoor, basic)).toMatchObject({
      kind: 'refused',
      reason: 'tag_not_allowed',
    });
    const { pass } = await f.pass();
    const uid = uid7();
    await enrolledSunTag(f.kit, ks, uid, pass, 5);
    expect(await act(secureDoor, await sunTap(ks, uid, 6))).toMatchObject({ kind: 'ok' });
    // The same Basic tag opens a door with no level.
    const plain = await f.door();
    expect(await act(plain, basic)).not.toMatchObject({ reason: 'tag_not_allowed' });
  });

  it('turns every tag away at level off', async () => {
    const off = await f.kit.scanner({
      templateIds: [f.tpl],
      settings: { roleWithoutSignIn: 'door', tags: { level: 'off' } },
    });
    const { pass } = await f.pass();
    const uid = uid7();
    await enrolledSunTag(f.kit, ks, uid, pass, 5);
    expect(await act(off, await sunTap(ks, uid, 6))).toMatchObject({ reason: 'tag_not_allowed' });
  });
});

describe('SUN failures', () => {
  it('count per device, log TAG_SUN_FAILED and write an event; a stale or other-mode read is not one', async () => {
    const logs: { event: string; data: Record<string, unknown> }[] = [];
    const log = {
      warn: (event: string, data: Record<string, unknown>) => logs.push({ event, data }),
      info: () => undefined,
    };
    const ctx = { ...f.kit.ctx, log } as never;
    const who = {
      orgId: f.kit.org.id,
      mode: 'live' as const,
      actorKey: `k-${key()}`,
      scanner: null,
    };
    await noteSunFailure(ctx, who, 'TAG_SUN_VERIFY');
    await noteSunFailure(ctx, who, 'TAG_SUN_KEYSET');
    await noteSunFailure(ctx, who, 'TAG_SUN_REPLAY');
    await noteSunFailure(ctx, who, 'TAG_SUN_MODE');
    expect(logs.map((l) => l.data.count)).toEqual([1, 2]);
    expect(logs[0]).toMatchObject({
      event: 'scan.tag_sun_failed',
      data: { code: 'TAG_SUN_FAILED', reason: 'TAG_SUN_VERIFY', orgId: f.kit.org.id },
    });
    expect(JSON.stringify(logs)).not.toMatch(/[0-9a-f]{16}/);
  });

  it('are counted when a door refuses a bad tap', async () => {
    const door = await f.door();
    const before = await f.count(
      "SELECT coalesce(sum(count), 0) AS n FROM counters WHERE key LIKE 'scan:tag:sunfail:%'",
    );
    expect(await act(door, await sunTap(ks, uid7(), 1, { m: '0000000000000000' }))).toMatchObject(
      refused,
    );
    expect(
      await f.count(
        "SELECT coalesce(sum(count), 0) AS n FROM counters WHERE key LIKE 'scan:tag:sunfail:%'",
      ),
    ).toBe(before + 1);
  });
});
