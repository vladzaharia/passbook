import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { addType, clearTypes, doorCalls, json } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { DAY } from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
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

/** A tag bound to a fresh pass by a Desk, of the type asked for (none: Standard). */
async function bound(typeId?: string) {
  const s = await f.desk();
  const { card, pass } = await f.pass();
  const tag = f.read();
  const res = await f.bind(s, { card, tag, ...(typeId ? { typeId } : {}) });
  expect(res.status).toBe(200);
  return { tag, pass };
}
const ready = { kind: 'ready' };
const refused = (reason: string) => ({ kind: 'refused', reason });
const headsUp = (reason: string) => ({ kind: 'heads_up', reason });

describe('expiry', () => {
  it('a tag whose assignment ended is refused as expired at resolve and act, and a Standard tag is not', async () => {
    const wrist = await addType(f, { bindingDays: 1 });
    const { tag } = await bound(wrist);
    const s = await f.desk();
    expect(await door.post(s, '/resolve', tag)).toMatchObject(ready);
    f.kit.clock.set(TEST_NOW + DAY - 1);
    expect(await door.post(s, '/resolve', tag)).toMatchObject(ready);
    f.kit.clock.set(TEST_NOW + DAY);
    expect(await door.post(s, '/resolve', tag)).toMatchObject(refused('tag_expired'));
    expect(await door.post(s, '/actions', tag)).toMatchObject(refused('tag_expired'));
    await clearTypes(f);
    const plain = await bound();
    f.kit.clock.set(TEST_NOW + 3 * DAY);
    expect(await door.post(s, '/resolve', plain.tag)).toMatchObject(ready);
  });

  it('every role gets the refusal, and a Door shows no tag data', async () => {
    const wrist = await addType(f, { bindingDays: 1 });
    const { tag } = await bound(wrist);
    f.kit.clock.set(TEST_NOW + 2 * DAY);
    const d = await f.door();
    expect(await door.post(d, '/resolve', tag)).toMatchObject(refused('tag_expired'));
    expect((await door.post(d, '/resolve', tag)).tag).toBeUndefined();
  });
});

describe('session types', () => {
  it('a door that names types takes those, and `standard` for a tag with none', async () => {
    const plain = await bound();
    const wrist = await addType(f, { name: 'Wristband' });
    const typed = await bound(wrist);
    const only = await f.desk({ tags: { types: [wrist] } });
    expect(await door.post(only, '/resolve', typed.tag)).toMatchObject(ready);
    expect(await door.post(only, '/resolve', plain.tag)).toMatchObject(refused('tag_not_allowed'));
    expect(await door.post(only, '/actions', plain.tag)).toMatchObject(refused('tag_not_allowed'));
    const standard = await f.desk({ tags: { types: ['standard'] } });
    expect(await door.post(standard, '/resolve', plain.tag)).toMatchObject(ready);
    expect(await door.post(standard, '/resolve', typed.tag)).toMatchObject(
      refused('tag_not_allowed'),
    );
    expect(await door.post(standard, '/actions', typed.tag)).toMatchObject(
      refused('tag_not_allowed'),
    );
  });

  it('no list takes every type, an empty list none', async () => {
    const wrist = await addType(f);
    const typed = await bound(wrist);
    const any = await f.desk();
    expect(await door.post(any, '/resolve', typed.tag)).toMatchObject(ready);
    const none = await f.desk({ tags: { types: [] } });
    expect(await door.post(none, '/resolve', typed.tag)).toMatchObject(refused('tag_not_allowed'));
  });

  it('an unknown type id takes nothing', async () => {
    const { tag } = await bound();
    const s = await f.desk({ tags: { types: [f.kit.fx.ids.id()] } });
    expect(await door.post(s, '/resolve', tag)).toMatchObject(refused('tag_not_allowed'));
  });
});

describe('a second factor', () => {
  it('a type that asks for staff holds the tap for a Desk to confirm', async () => {
    const visitor = await addType(f, { confirm: 'staff' });
    const { tag, pass } = await bound(visitor);
    const s = await f.desk();
    const first = await door.post(s, '/resolve', tag);
    expect(first).toMatchObject(headsUp('check_required'));
    expect(JSON.stringify(first)).toContain('Basic tag');
    expect(await door.post(s, '/actions', tag)).toMatchObject(headsUp('check_required'));
    const done = await door.post(s, '/actions', tag, {}, { confirmed: true });
    expect(done).toMatchObject({ kind: 'ok' });
    expect(
      await f.count('SELECT count(*) AS n FROM scans WHERE pass_id = ? AND outcome = ?', [
        pass.id,
        'ok',
      ]),
    ).toBe(1);
  });

  it('a Door has nobody to confirm: it cannot confirm its own scan', async () => {
    const visitor = await addType(f, { confirm: 'staff' });
    const { tag } = await bound(visitor);
    const d = await f.door();
    expect(await door.post(d, '/resolve', tag)).toMatchObject(headsUp('check_required'));
    expect(await door.post(d, '/actions', tag, {}, { confirmed: true })).toMatchObject(
      headsUp('check_required'),
    );
  });

  it('a type that asks for a manager needs a PIN, or a signed-in Manager', async () => {
    const vip = await addType(f, { confirm: 'manager' });
    const { tag } = await bound(vip);
    const s = await f.desk();
    expect(await door.post(s, '/resolve', tag)).toMatchObject(headsUp('needs_approval'));
    expect(await door.post(s, '/actions', tag)).toMatchObject(headsUp('needs_approval'));
    expect(await door.post(s, '/actions', tag, {}, { confirmed: true })).toMatchObject(
      headsUp('needs_approval'),
    );
    const boss = await f.kit.staff('manager');
    const wrong = await f.kit.post(s.headers, '/actions', {
      idempotencyKey: (await import('./test-kit.ts')).key(),
      input: { tag, method: 'nfc' },
      clientTs: f.kit.clock.now(),
      actionId: 'auto',
      approval: { staffId: boss.id, pin: '000000' },
    });
    expect(wrong.status).toBe(400);
    expect(
      await door.post(s, '/actions', tag, {}, { approval: { staffId: boss.id, pin: boss.pin } }),
    ).toMatchObject({ kind: 'ok' });
    const m = await f.manager();
    expect(await door.post(m.scanner, '/resolve', tag)).toMatchObject(ready);
    const other = await bound(vip);
    expect(await door.post(m.scanner, '/actions', other.tag)).toMatchObject({ kind: 'ok' });
  });

  it('session confirmBasic asks the same of a Basic tag, and the strictest of the two wins', async () => {
    const plain = await bound();
    const none = await addType(f, { name: 'None' });
    const mgr = await addType(f, { name: 'Mgr', confirm: 'manager' });
    const typed = await bound(none);
    const strict = await bound(mgr);
    const staffCheck = await f.desk({ tags: { confirmBasic: 'staff' } });
    for (const t of [plain, typed])
      expect(await door.post(staffCheck, '/resolve', t.tag)).toMatchObject(
        headsUp('check_required'),
      );
    expect(await door.post(staffCheck, '/resolve', strict.tag)).toMatchObject(
      headsUp('needs_approval'),
    );
    const managerCheck = await f.desk({ tags: { confirmBasic: 'manager' } });
    expect(await door.post(managerCheck, '/resolve', plain.tag)).toMatchObject(
      headsUp('needs_approval'),
    );
    const open = await f.desk({ tags: { confirmBasic: 'none' } });
    expect(await door.post(open, '/resolve', plain.tag)).toMatchObject(ready);
  });

  it('no type and no session rule: the tap is as it was', async () => {
    const { tag } = await bound();
    const s = await f.desk();
    expect(await door.post(s, '/resolve', tag)).toMatchObject(ready);
    expect(await door.post(s, '/actions', tag)).toMatchObject({ kind: 'ok' });
  });

  it('a person-wide tag asks too, and a desk sees the type name', async () => {
    const visitor = await addType(f, { name: 'Visitor tag', confirm: 'staff', scopes: 'user' });
    const m = await f.manager();
    const { card, pass, ownerId } = await f.pass({ owner: true });
    expect(ownerId).not.toBeNull();
    const tag = f.read();
    expect((await f.bind(m.scanner, { card, tag, binding: 'user', typeId: visitor })).status).toBe(
      200,
    );
    const s = await f.desk();
    const res = await door.post(s, '/resolve', tag);
    expect(res).toMatchObject(headsUp('check_required'));
    expect(res.tag).toMatchObject({ system: 'uid', typeName: 'Visitor tag', scope: 'user' });
    expect(json).toBeDefined();
    expect(pass.id).toBeTruthy();
  });
});

describe('the type at the door after the bind', () => {
  it('a template taken off the type, or a use the template stops taking, refuses the tag', async () => {
    const fresh = await f.kit.scanTemplate('Edited', { actions: [CHECK_IN] });
    const wrist = await addType(f, { templateIds: [fresh] });
    const s = await f.desk({ templateIds: [fresh] });
    const { card } = await f.pass({ template: fresh });
    const tag = f.read();
    expect((await f.bind(s, { card, tag })).status).toBe(200);
    expect(await door.post(s, '/resolve', tag)).toMatchObject(ready);
    await run(f.kit.env.DB, 'DELETE FROM nfc_tag_type_templates WHERE type_id = ?', [wrist]);
    await run(
      f.kit.env.DB,
      'INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES (?, ?)',
      [wrist, f.otherTpl],
    );
    expect(await door.post(s, '/resolve', tag)).toMatchObject(refused('tag_not_allowed'));
    expect(await door.post(s, '/actions', tag)).toMatchObject(refused('tag_not_allowed'));
    await run(f.kit.env.DB, 'DELETE FROM nfc_tag_type_templates WHERE type_id = ?', [wrist]);
    expect(await door.post(s, '/resolve', tag)).toMatchObject(ready);
    await run(f.kit.env.DB, 'DROP TRIGGER template_versions_immutable');
    await run(
      f.kit.env.DB,
      'UPDATE template_versions SET manifest = json_set(manifest, \'$.scan.tags\', json(\'{"uses":["staff"]}\')) WHERE template_id = ?',
      [fresh],
    );
    expect(await door.post(s, '/resolve', tag)).toMatchObject(refused('tag_not_allowed'));
    expect(await door.post(s, '/actions', tag)).toMatchObject(refused('tag_not_allowed'));
  });
});
