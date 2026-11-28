import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import type { Pass } from '../passes/repo-map.ts';
import { act, CHECK_IN, kit, out, setupActionFixture, tpl } from './act-test-fixtures.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { barcodeHashOfCode, cleanCode } from './codes.ts';
import { RACE_GATE_WRITE } from './race-tags.ts';
import {
  actTag,
  bindTag,
  holder,
  nextUid,
  ownedPass,
  tagsOn,
} from './tags-resolve-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

let n = 0;
let lookupTpl: string;
const resolve = async (headers: Record<string, string>, input: unknown) => ({
  out: await out(
    await kit.post(headers, '/resolve', {
      idempotencyKey: key(),
      input,
      clientTs: kit.clock.now(),
    }),
  ),
});
beforeAll(async () => {
  await setupActionFixture();
  await tagsOn();
  lookupTpl = await kit.scanTemplate('Member card', {
    actions: [CHECK_IN],
    lookup: { input: 'memberNo' },
  });
});

const door = () => kit.scanner({ templateIds: [tpl, lookupTpl] });

async function channel(
  pass: Pass,
  name: string,
  over: { override?: 'on' | 'off' | null; retiredAt?: number | null },
) {
  await run(
    kit.env.DB,
    `INSERT INTO pass_channels (pass_id, org_id, mode, template_id, channel, override, retired_at, set_by, set_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'test', 1)
     ON CONFLICT (pass_id, channel) DO UPDATE SET override = excluded.override, retired_at = excluded.retired_at`,
    [
      pass.id,
      pass.orgId,
      pass.mode,
      pass.templateId,
      name,
      over.override ?? null,
      over.retiredAt ?? null,
    ],
  );
}
const allDigitalOff = async (pass: Pass, retired: Record<string, number> = {}) => {
  for (const c of ['mobile', 'apple', 'google', 'samsung'])
    await channel(pass, c, { override: 'off', retiredAt: retired[c] ?? null });
};
const rotate = (pass: Pass, at: number) =>
  run(
    kit.env.DB,
    `INSERT INTO scan_code_rotations (pass_id, org_id, mode, old_code_hash, new_version, rotated_at, actor_type)
     VALUES (?, ?, ?, ?, ?, ?, 'system')`,
    [pass.id, pass.orgId, pass.mode, 'a'.repeat(63) + (n++ % 10), pass.version + 1, at],
  );
/** A pass whose typed member number is its lookup, and (Henry's) its barcode too. */
async function numbered(sameAsBarcode: boolean) {
  const memberNo = `M-${++n}-${kit.fx.ids.token(3)}`;
  const pass = await kit.scanPass(lookupTpl, { memberNo });
  if (sameAsBarcode) {
    const hash = await barcodeHashOfCode(cleanCode(memberNo));
    await run(kit.env.DB, 'UPDATE passes SET barcode_hash = ?, revision=revision+1 WHERE id = ?', [
      hash,
      pass.id,
    ]);
  }
  return { pass, memberNo };
}

describe('channel_off', () => {
  it('refuses a scan code when every digital channel is off, naming the latest retired', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    await allDigitalOff(pass, { mobile: 10, apple: 20 });
    const { out: o } = await resolve(s.headers, codeOf(pass));
    expect(o).toMatchObject({
      kind: 'refused',
      reason: 'channel_off',
      channel: 'apple',
      card: null,
    });
  });

  it('keeps the pass on the scan row of an act', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    await allDigitalOff(pass);
    const o = await out(await act(s.headers, codeOf(pass), { actionId: CHECK_IN.id }));
    expect(o).toMatchObject({ kind: 'refused', reason: 'channel_off', card: null });
    const row = await first<{ pass_id: string | null; reason: string }>(
      kit.env.DB,
      'SELECT pass_id, reason FROM scans WHERE id = ?',
      [o.scanId],
    );
    expect(row).toEqual({ pass_id: pass.id, reason: 'channel_off' });
  });

  it('a barcode hit is refused too', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(true);
    await allDigitalOff(pass);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o).toMatchObject({ kind: 'refused', reason: 'channel_off' });
  });

  it('one digital channel on keeps the pass admitted', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    await channel(pass, 'mobile', { override: 'off' });
    const { out: o } = await resolve(s.headers, codeOf(pass));
    expect(o.kind).toBe('ready');
  });
});

describe('typed numbers', () => {
  it('a plain turn off does not make a typed lookup a heads-up', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'manual' });
    expect(o.kind).toBe('ready');
  });

  it('checks a typed lookup after a New code followed a retirement', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    await rotate(pass, 6);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'manual' });
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });

  it('a rotation before the retirement is not a heads-up', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await rotate(pass, 3);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'manual' });
    expect(o.kind).toBe('ready');
  });

  it("Henry's barcode equals its lookup: the scan is a barcode hit, never a heads-up", async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(true);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    await rotate(pass, 6);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o.kind).toBe('ready');
  });

  it('a typed lookup on an all-off pass is checked, not refused', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await allDigitalOff(pass);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'manual' });
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });
});

describe('linked NFC', () => {
  it('drops a pass with NFC off; the other passes of the binding still resolve', async () => {
    const s = await door();
    const user = await holder();
    const a = await ownedPass(tpl, user);
    kit.clock.advance(1);
    const b = await ownedPass(tpl, user);
    const uid = nextUid();
    await bindTag(uid, a, { userId: user });
    await channel(a, 'nfc', { override: 'off' });
    await channel(b, 'nfc', { override: 'on' });
    const done = await actTag(s.headers, uid);
    expect(done).toMatchObject({ kind: 'ok' });
    const row = await first<{ pass_id: string }>(
      kit.env.DB,
      'SELECT pass_id FROM scans WHERE id = ?',
      [done.scanId],
    );
    expect(row?.pass_id).toBe(b.id);
  });

  it('answers channel_off, with Linked NFC named, when no pass of the tag is left', async () => {
    const s = await door();
    const pass = await ownedPass(tpl, await holder());
    const uid = nextUid();
    await bindTag(uid, pass);
    await channel(pass, 'nfc', { override: 'off' });
    const done = await actTag(s.headers, uid);
    expect(done).toMatchObject({
      kind: 'refused',
      reason: 'channel_off',
      channel: 'nfc',
      card: null,
    });
    expect(
      await first(kit.env.DB, 'SELECT reason FROM scans WHERE id = ?', [done.scanId]),
    ).toMatchObject({ reason: 'channel_off' });
  });
});

describe('the commit fence', () => {
  const raced = async (change: (pass: Pass) => Promise<unknown>) => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const { result, fired } = await beforeBatch(
      kit.env,
      RACE_GATE_WRITE,
      () => change(pass),
      () => act(s.headers, codeOf(pass), { actionId: CHECK_IN.id }),
    );
    expect(fired).toBe(true);
    const gates = await first(kit.env.DB, 'SELECT 1 AS n FROM scan_gates WHERE pass_id = ?', [
      pass.id,
    ]);
    return { s, pass, outcome: await out(result), gates };
  };

  it('refuses a check-in when a channel is turned off between read and commit', async () => {
    const { s, pass, outcome, gates } = await raced(allDigitalOff);
    expect(outcome.kind).not.toBe('ok');
    expect(gates).toBeNull();
    const again = await out(await act(s.headers, codeOf(pass), { actionId: CHECK_IN.id }));
    expect(again).toMatchObject({ kind: 'refused', reason: 'channel_off' });
  });

  it('refuses when the template policy changes between read and commit', async () => {
    const { outcome, gates } = await raced((pass) =>
      run(
        kit.env.DB,
        `INSERT INTO template_channel_policies (org_id, mode, template_id, channels, updated_by, updated_at)
         VALUES (?, ?, ?, '{}', 'test', 1)`,
        [pass.orgId, pass.mode, pass.templateId],
      ),
    );
    expect(outcome.kind).not.toBe('ok');
    expect(gates).toBeNull();
  });
});

describe('desk lookup', () => {
  it('marks a pass whose digital channels are all off', async () => {
    const s = await kit.scanner({
      templateIds: [tpl],
      settings: { lookup: true, roleWithoutSignIn: 'desk' },
    });
    const off = await kit.scanPass(tpl);
    const on = await kit.scanPass(tpl);
    await allDigitalOff(off);
    const rows = async (pass: Pass) => {
      const res = await kit.post(s.headers, '/lookup', { q: pass.serial });
      return ((await res.json()) as { items: { passId: string; channelsOff?: boolean }[] }).items;
    };
    expect((await rows(off)).find((r) => r.passId === off.id)?.channelsOff).toBe(true);
    expect((await rows(on)).find((r) => r.passId === on.id)?.channelsOff).toBeUndefined();
  });
});

describe('typed numbers: reads that are not typed, and desk picks', () => {
  it('a camera read of an all-off pass lookup is channel_off, not a heads-up', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await allDigitalOff(pass);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o).toMatchObject({ kind: 'refused', reason: 'channel_off' });
  });

  it('a camera read of the lookup value alone is checked, not admitted', async () => {
    const s = await door();
    const { memberNo } = await numbered(false);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });

  it('a typed lookup stays ready, and the real barcode still admits', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    expect((await resolve(s.headers, { code: memberNo, method: 'manual' })).out.kind).toBe('ready');
    expect((await resolve(s.headers, codeOf(pass))).out.kind).toBe('ready');
  });

  it('a desk pick of an all-off pass is a typed-number heads-up', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    await allDigitalOff(pass);
    const { out: o } = await resolve(s.headers, { passId: pass.id, method: 'manual' });
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });

  it('a desk pick of a pass with a digital channel on is not checked', async () => {
    const s = await door();
    const pass = await kit.scanPass(tpl);
    const { out: o } = await resolve(s.headers, { passId: pass.id, method: 'manual' });
    expect(o.kind).toBe('ready');
  });
});

describe('lookup matches by any read method', () => {
  it('a camera read of a rotated pass lookup is checked', async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(false);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    await rotate(pass, 6);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
      flags: ['Typed number'],
    });
  });

  it("a camera read of a rotated pass barcode (Henry's) is not", async () => {
    const s = await door();
    const { pass, memberNo } = await numbered(true);
    await channel(pass, 'apple', { override: 'off', retiredAt: 5 });
    await rotate(pass, 6);
    const { out: o } = await resolve(s.headers, { code: memberNo, method: 'camera' });
    expect(o.kind).toBe('ready');
  });
});
