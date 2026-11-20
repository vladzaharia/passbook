import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { addType, clearTypes, json, setDefaultType, typeOf } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { DAY } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});
afterEach(async () => {
  await clearTypes(f);
  await setDefaultType(f, null);
  f.kit.clock.set(TEST_NOW);
});

const bound = async (res: Response) => {
  expect(res.status).toBe(200);
  return json(res);
};
const refusal = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(await json(res)).toMatchObject({ code });
};
const expiry = (bindingId: unknown) =>
  first<{ expires_at: number | null }>(
    f.kit.env.DB,
    'SELECT expires_at FROM tag_bindings WHERE id = ?',
    [String(bindingId)],
  ).then((r) => r?.expires_at ?? null);

describe('which type a new tag gets', () => {
  it('the only active type of its system that fits the pass, with its expiry', async () => {
    const wrist = await addType(f, { name: 'Wristband', bindingDays: 2 });
    const s = await f.desk();
    const { card } = await f.pass();
    const res = await bound(await f.bind(s, { card }));
    expect(res.type).toMatchObject({ id: wrist, name: 'Wristband', use: 'member' });
    expect(await typeOf(f, await tagOf(String(res.bindingId)))).toBe(wrist);
    expect(await expiry(res.bindingId)).toBe(f.kit.clock.now() + 2 * DAY);
  });

  it('Standard when no type fits the pass: no type, no expiry', async () => {
    await addType(f, { templateIds: [f.otherTpl], bindingDays: 1 });
    const s = await f.desk();
    const { card } = await f.pass();
    const res = await bound(await f.bind(s, { card }));
    expect(res.type).toBeNull();
    expect(await expiry(res.bindingId)).toBeNull();
  });

  it('several fit: the org default if it is one of them, else the scanner must pick', async () => {
    await addType(f, { name: 'A' });
    const b = await addType(f, { name: 'B' });
    const s = await f.desk();
    const { card, pass } = await f.pass();
    await refusal(await f.bind(s, { card }), 409, 'TAG_TYPE_CHOOSE');
    expect(await json(await f.bind(s, { card, preview: true }))).toMatchObject({
      detail: 'Pick a tag type.',
    });
    expect(await onPass(pass.id)).toBe(0);
    await setDefaultType(f, b);
    const preferred = await bound(await f.bind(s, { card: (await f.pass()).card }));
    expect(preferred.type).toMatchObject({ id: b });
  });

  it('a type that cannot take this bind is not a candidate: scope, typed and room', async () => {
    const m = await f.manager();
    await addType(f, { name: 'Pass only', scopes: 'pass' });
    const user = await addType(f, { name: 'Person', scopes: 'user' });
    const owner = await f.pass({ owner: true });
    expect(
      (await bound(await f.bind(m.scanner, { card: owner.card, binding: 'user' }))).type,
    ).toMatchObject({ id: user });
    await clearTypes(f);
    const wrist = await addType(f, { name: 'Wristband' });
    const full = await f.pass();
    expect((await bound(await f.bind(m.scanner, { card: full.card }))).type).toMatchObject({
      id: wrist,
    });
    // The pass has its wristband: a second tag is not offered the type, and is Standard.
    expect((await bound(await f.bind(m.scanner, { card: full.card }))).type).toBeNull();
  });

  it('a type asked for wins over the default', async () => {
    const a = await addType(f, { name: 'A' });
    const b = await addType(f, { name: 'B' });
    await setDefaultType(f, b);
    const s = await f.desk();
    const res = await bound(await f.bind(s, { card: (await f.pass()).card, typeId: a }));
    expect(res.type).toMatchObject({ id: a });
  });

  it('refuses an unknown, archived or other-system type', async () => {
    const s = await f.desk();
    const { card, pass } = await f.pass();
    await refusal(await f.bind(s, { card, typeId: f.kit.fx.ids.id() }), 404, 'TAG_TYPE_NOT_FOUND');
    const sun = await addType(f, { system: 'sun' });
    await refusal(await f.bind(s, { card, typeId: sun }), 409, 'TAG_TYPE_SYSTEM');
    const old = await addType(f, { name: 'Old' });
    await clearTypes(f);
    await refusal(await f.bind(s, { card, typeId: old }), 409, 'TAG_TYPE_ARCHIVED');
    expect(await onPass(pass.id)).toBe(0);
  });

  it('an existing tag keeps its type, and another is refused', async () => {
    const a = await addType(f, { name: 'A', perPass: 2 });
    const b = await addType(f, { name: 'B' });
    const s = await f.desk();
    const tag = f.read();
    const first = await bound(await f.bind(s, { card: (await f.pass()).card, tag, typeId: a }));
    await bound(await f.undo(s, String(first.bindingId)));
    const again = await f.pass();
    await refusal(await f.bind(s, { card: again.card, tag, typeId: b }), 409, 'TAG_TYPE_SET');
    const kept = await bound(await f.bind(s, { card: again.card, tag }));
    expect(kept.type).toMatchObject({ id: a });
  });
});

describe('what a type allows on a pass', () => {
  it('a type of other templates is refused for this pass', async () => {
    const t = await addType(f, { templateIds: [f.otherTpl] });
    const s = await f.desk();
    const { card, pass } = await f.pass();
    for (const preview of [false, true])
      await refusal(await f.bind(s, { card, typeId: t, preview }), 409, 'TAG_TYPE_MISMATCH');
    expect(await onPass(pass.id)).toBe(0);
  });

  it('the template names the uses it takes: Standard is a member tag', async () => {
    const staffOnly = await f.kit.scanTemplate('Staff area', {
      actions: [CHECK_IN],
      tags: { uses: ['staff'] },
    });
    const s = await f.desk({ templateIds: [staffOnly] });
    const { card } = await f.pass({ template: staffOnly });
    await refusal(await f.bind(s, { card }), 409, 'TAG_USE_MISMATCH');
    const badge = await addType(f, { use: 'staff' });
    const res = await bound(await f.bind(s, { card, typeId: badge }));
    expect(res.type).toMatchObject({ id: badge, use: 'staff' });
    const visitor = await addType(f, { use: 'visitor' });
    await refusal(
      await f.bind(s, { card: (await f.pass({ template: staffOnly })).card, typeId: visitor }),
      409,
      'TAG_USE_MISMATCH',
    );
  });

  it('a pass-only type refuses a person-wide tag, and a person-only type a pass tag', async () => {
    const m = await f.manager();
    const onlyPass = await addType(f, { name: 'Pass', scopes: 'pass' });
    const onlyUser = await addType(f, { name: 'User', scopes: 'user' });
    const { card } = await f.pass({ owner: true });
    await refusal(
      await f.bind(m.scanner, { card, binding: 'user', typeId: onlyPass }),
      409,
      'TAG_TYPE_SCOPE',
    );
    await refusal(
      await f.bind(m.scanner, { card, binding: 'pass', typeId: onlyUser }),
      409,
      'TAG_TYPE_SCOPE',
    );
    expect(
      (await bound(await f.bind(m.scanner, { card, binding: 'user', typeId: onlyUser }))).scope,
    ).toBe('user');
  });

  it('a pass holds per_pass tags of a type, and a tag of another type besides', async () => {
    const wrist = await addType(f, { name: 'Wristband', perPass: 2 });
    const card2 = await addType(f, { name: 'Card' });
    const s = await f.desk();
    const { card, pass } = await f.pass();
    await bound(await f.bind(s, { card, typeId: wrist }));
    await bound(await f.bind(s, { card, typeId: wrist }));
    await refusal(await f.bind(s, { card, typeId: wrist }), 409, 'TAG_TYPE_LIMIT');
    expect(await json(await f.bind(s, { card, typeId: wrist }))).toMatchObject({
      detail: 'This pass has its Wristband already.',
    });
    await bound(await f.bind(s, { card, typeId: card2 }));
    expect(await onPass(pass.id)).toBe(3);
  });

  it('a Standard tag keeps the limit of four', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    for (let i = 0; i < 4; i++) await bound(await f.bind(s, { card }));
    await refusal(await f.bind(s, { card }), 409, 'TAG_BINDING_LIMIT');
  });
});

describe('the scanner session at bind', () => {
  it('a Secure-only session refuses to bind a Basic tag, a session with tags off any', async () => {
    const secure = await f.desk({ tags: { level: 'secure' } });
    const off = await f.desk({ tags: { level: 'off' } });
    const { card, pass } = await f.pass();
    for (const preview of [false, true]) {
      await refusal(await f.bind(secure, { card, preview }), 409, 'TAG_SECURE_REQUIRED');
      await refusal(await f.bind(off, { card, preview }), 409, 'TAGS_OFF');
    }
    expect(await onPass(pass.id)).toBe(0);
    const basic = await f.desk({ tags: { level: 'basic' } });
    await bound(await f.bind(basic, { card }));
  });
});

const onPass = (passId: string) =>
  f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ? AND ended_at IS NULL', [
    passId,
  ]);
const tagOf = async (bindingId: string) =>
  (
    await first<{ tag_id: string }>(f.kit.env.DB, 'SELECT tag_id FROM tag_bindings WHERE id = ?', [
      bindingId,
    ])
  )?.tag_id ?? '';
