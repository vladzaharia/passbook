import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { expireBindings } from '../nfc/expiry.ts';
import { addType, clearTypes, doorCalls, json } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { DAY } from './test-kit.ts';

let f: TagScanFixture;
let door: ReturnType<typeof doorCalls>;
beforeAll(async () => {
  f = await tagScanFixture();
  door = doorCalls(f);
});
afterEach(async () => {
  await clearTypes(f);
  f.kit.clock.set(TEST_NOW);
});

const LAPSED = DAY + 1;
const causeOf = (bindingId: unknown) =>
  first<{ end_cause: string | null; ended_by: string | null; ended_by_type: string | null }>(
    f.kit.env.DB,
    'SELECT end_cause, ended_by, ended_by_type FROM tag_bindings WHERE id = ?',
    [String(bindingId)],
  );
const expiresOf = async (bindingId: unknown) =>
  (
    await first<{ expires_at: number | null }>(
      f.kit.env.DB,
      'SELECT expires_at FROM tag_bindings WHERE id = ?',
      [String(bindingId)],
    )
  )?.expires_at;

describe('a lapsed binding holds nobody up', () => {
  it('the same holder taps an expired tag again and gets a fresh assignment', async () => {
    await addType(f, { bindingDays: 1 });
    const s = await f.desk();
    const { card } = await f.pass();
    const tag = f.read();
    const first = await json(await f.bind(s, { card, tag }));
    expect(first.status).toBe('bound');
    f.kit.clock.set(TEST_NOW + LAPSED);
    expect(await door.post(s, '/resolve', tag)).toMatchObject({ reason: 'tag_expired' });
    const again = await json(await f.bind(s, { card, tag }));
    expect(again.status).toBe('bound');
    expect(again.bindingId).not.toBe(first.bindingId);
    expect(await causeOf(first.bindingId)).toEqual({
      end_cause: 'expired',
      ended_by: 'expiry',
      ended_by_type: 'system',
    });
    expect(await expiresOf(again.bindingId)).toBe(f.kit.clock.now() + DAY);
    expect(await door.post(s, '/resolve', tag)).toMatchObject({ kind: 'ready' });
  });

  it('another holder takes an expired tag without a move', async () => {
    await addType(f, { bindingDays: 1 });
    const s = await f.desk();
    const tag = f.read();
    const first = await json(await f.bind(s, { card: (await f.pass()).card, tag }));
    f.kit.clock.set(TEST_NOW + LAPSED);
    const next = await f.pass();
    const res = await f.bind(s, { card: next.card, tag });
    expect(res.status).toBe(200);
    expect((await causeOf(first.bindingId))?.end_cause).toBe('expired');
  });

  it('a per_pass 1 Visitor tag is replaced by another once it expired', async () => {
    const visitor = await addType(f, { name: 'Visitor tag', use: 'visitor', bindingDays: 1 });
    const s = await f.desk();
    const { card } = await f.pass();
    const a = await json(await f.bind(s, { card, typeId: visitor }));
    const blocked = await f.bind(s, { card, typeId: visitor });
    expect(blocked.status).toBe(409);
    expect(await json(blocked)).toMatchObject({ code: 'TAG_TYPE_LIMIT' });
    f.kit.clock.set(TEST_NOW + LAPSED);
    const b = await f.bind(s, { card, typeId: visitor });
    expect(b.status, await b.clone().text()).toBe(200);
    expect((await causeOf(a.bindingId))?.end_cause).toBe('expired');
  });
});

describe('the expiry job', () => {
  it('ends the bindings past their expiry, once, and audits them', async () => {
    await addType(f, { bindingDays: 1 });
    const s = await f.desk();
    const lapsing: unknown[] = [];
    for (let i = 0; i < 3; i++)
      lapsing.push((await json(await f.bind(s, { card: (await f.pass()).card }))).bindingId);
    await clearTypes(f);
    const plain = await json(await f.bind(s, { card: (await f.pass()).card }));
    const job = jobCtxOf(f.kit);
    expect(await expireBindings(job)).toBe(0);
    f.kit.clock.set(TEST_NOW + LAPSED);
    expect(await expireBindings(job)).toBe(3);
    for (const id of lapsing)
      expect(await causeOf(id)).toMatchObject({ end_cause: 'expired', ended_by_type: 'system' });
    expect((await causeOf(plain.bindingId))?.end_cause).toBeNull();
    expect(await expireBindings(job)).toBe(0);
    const audits = await all<{ target_id: string }>(
      f.kit.env.DB,
      "SELECT target_id FROM audit_log WHERE action = 'tag.expire'",
    );
    expect(audits).toHaveLength(3);
  });
});
