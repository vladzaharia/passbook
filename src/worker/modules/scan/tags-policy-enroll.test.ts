import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { type SunKeyset, sunKeyset, sunTap } from './sun-test-fixtures.ts';
import { type EnrollFixture, enrollFixture } from './tags-enroll-test-fixtures.ts';
import { addType, clearTypes, doorCalls, json } from './tags-policy-test-fixtures.ts';
import { DAY } from './test-kit.ts';

let f: EnrollFixture;
let ks: SunKeyset;
let door: ReturnType<typeof doorCalls>;
beforeAll(async () => {
  f = await enrollFixture();
  ks = await sunKeyset(f.kit, f.kit.org.id, { diversify: true });
  door = doorCalls(f);
});
afterEach(() => clearTypes(f));

const uid7 = () =>
  `04${(Math.random() * 2 ** 48).toString(16).replace('.', '').padEnd(12, '0').slice(0, 12)}`;

/** A remote request on `scanner` for a fresh pass, completed with `tag`. */
async function enrol(
  scanner: { id: string; headers: Record<string, string> },
  tag: unknown,
  binding: 'pass' | 'user' = 'pass',
  pass?: { id: string },
) {
  const target = pass ?? (await f.pass({ owner: binding === 'user' })).pass;
  const made = await f.nfc(f.operator.headers, 'POST', `/passes/${target.id}/enrollments`, {
    scannerId: scanner.id,
    binding,
  });
  expect(made.status, await made.clone().text()).toBe(200);
  const { id } = (await made.json()) as { id: string };
  return {
    pass: target,
    done: await f.kit.post(scanner.headers, `/tag-enrollments/${id}/complete`, { tag }),
  };
}
const typeAndExpiry = (bindingId: unknown) =>
  first<{ type_id: string | null; expires_at: number | null }>(
    f.kit.env.DB,
    `SELECT t.type_id, b.expires_at FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id WHERE b.id = ?`,
    [String(bindingId)],
  );

describe('a remote request follows the type rules', () => {
  it('the tag gets the only type that fits, with its expiry', async () => {
    const wrist = await addType(f, { name: 'Wristband', bindingDays: 3 });
    const scanner = await f.device('desk');
    const socket = await f.connect(scanner.id);
    const { done } = await enrol(scanner, f.read());
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await typeAndExpiry((await json(done)).bindingId)).toEqual({
      type_id: wrist,
      expires_at: f.kit.clock.now() + 3 * DAY,
    });
    socket.socket.close(1000);
  });

  it('a type with no room on the pass refuses the completion', async () => {
    await addType(f, { name: 'Wristband' });
    const scanner = await f.device('desk');
    const socket = await f.connect(scanner.id);
    const first = await enrol(scanner, f.read());
    expect(first.done.status).toBe(200);
    const second = await enrol(scanner, f.read(), 'pass', first.pass);
    expect(second.done.status).toBe(409);
    expect(await json(second.done)).toMatchObject({ code: 'TAG_TYPE_LIMIT' });
    socket.socket.close(1000);
  });

  it('a type that takes a pass only refuses a person-wide request', async () => {
    await addType(f, { scopes: 'pass' });
    const scanner = await f.device('desk');
    const socket = await f.connect(scanner.id);
    const { done } = await enrol(scanner, f.read(), 'user');
    expect(done.status).toBe(409);
    expect(await json(done)).toMatchObject({ code: 'TAG_TYPE_SCOPE' });
    socket.socket.close(1000);
  });
});

describe('re-binding an existing tag', () => {
  it('widening a pass-only tag to the person is refused by its type', async () => {
    const only = await addType(f, { scopes: 'pass' });
    const desk = await f.desk();
    const { card, pass } = await f.pass({ owner: true });
    const bound = await json(await f.bind(desk, { card, typeId: only }));
    const res = await f.nfc(f.operator.headers, 'PATCH', `/bindings/${bound.bindingId}`, {
      binding: 'user',
    });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAG_TYPE_SCOPE' });
    expect(pass.id).toBeTruthy();
  });
});

describe("a session's tag rules, set on the session and read at the door", () => {
  it('a Secure-only session refuses a Basic tag at completion', async () => {
    const scanner = await f.device('desk', { tags: { level: 'secure' } });
    const socket = await f.connect(scanner.id);
    const { pass } = await f.pass();
    const made = await f.nfc(f.operator.headers, 'POST', `/passes/${pass.id}/enrollments`, {
      scannerId: scanner.id,
      binding: 'pass',
    });
    const { id } = (await made.json()) as { id: string };
    const basic = await f.kit.post(scanner.headers, `/tag-enrollments/${id}/complete`, {
      tag: f.read(),
    });
    expect(basic.status).toBe(409);
    expect(await json(basic)).toMatchObject({ code: 'TAG_SECURE_REQUIRED' });
    const secure = await f.kit.post(scanner.headers, `/tag-enrollments/${id}/complete`, {
      tag: await sunTap(ks, uid7(), 2),
    });
    expect(secure.status).toBe(200);
    socket.socket.close(1000);
  });

  it('types and confirmBasic reach the door from a session', async () => {
    const wrist = await addType(f, { name: 'Wristband' });
    const setup = await f.device('desk');
    const { card } = await f.pass();
    const typed = f.read();
    expect((await f.bind(setup, { card, tag: typed, typeId: wrist })).status).toBe(200);
    const plain = f.read();
    await clearTypes(f);
    expect((await f.bind(setup, { card: (await f.pass()).card, tag: plain })).status).toBe(200);
    const only = await f.device('desk', { tags: { types: [wrist] } });
    expect(await door.post(only, '/resolve', typed)).toMatchObject({ kind: 'ready' });
    expect(await door.post(only, '/resolve', plain)).toMatchObject({
      kind: 'refused',
      reason: 'tag_not_allowed',
    });
    const checked = await f.device('desk', { tags: { confirmBasic: 'staff' } });
    expect(await door.post(checked, '/resolve', plain)).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
    });
  });
});

describe('a Secure tag', () => {
  it('is not held by the session rule for Basic tags, and is by its own type', async () => {
    const staffOnly = await f.kit.scanTemplate('Staff area', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      tags: { uses: ['staff'] },
    });
    const desk = await f.desk({ templateIds: [staffOnly] });
    const checked = await f.desk({ templateIds: [staffOnly], tags: { confirmBasic: 'staff' } });
    const mk = async (typeId?: string) => {
      const { card } = await f.pass({ template: staffOnly });
      const uid = uid7();
      const bound = await f.bind(desk, {
        card,
        tag: await sunTap(ks, uid, 1),
        ...(typeId ? { typeId } : {}),
      });
      return { uid, bound };
    };
    // A Secure tag of no type is a member tag, and a staff-only template refuses it.
    expect(await json((await mk()).bound)).toMatchObject({ code: 'TAG_USE_MISMATCH' });
    const badge = await addType(f, { name: 'Badge', system: 'sun', use: 'staff' });
    const vault = await addType(f, {
      name: 'Vault',
      system: 'sun',
      use: 'staff',
      confirm: 'staff',
    });
    const open = await mk(badge);
    expect(open.bound.status).toBe(200);
    const held = await mk(vault);
    expect(held.bound.status).toBe(200);
    expect(await door.post(checked, '/resolve', await sunTap(ks, open.uid, 2))).toMatchObject({
      kind: 'ready',
    });
    expect(await door.post(checked, '/resolve', await sunTap(ks, held.uid, 2))).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
    });
    expect(
      JSON.stringify(await door.post(desk, '/resolve', await sunTap(ks, held.uid, 3))),
    ).toContain('Tag check');
  });

  it('a tap held for a check is confirmed once with the same read, then used up', async () => {
    const vault = await addType(f, { system: 'sun', confirm: 'staff' });
    const desk = await f.desk();
    const { card, pass } = await f.pass();
    const uid = uid7();
    expect(
      (await f.bind(desk, { card, tag: await sunTap(ks, uid, 1), typeId: vault })).status,
    ).toBe(200);
    const tap = await sunTap(ks, uid, 2);
    expect(await door.post(desk, '/actions', tap)).toMatchObject({
      kind: 'heads_up',
      reason: 'check_required',
    });
    expect(await door.post(desk, '/actions', tap, {}, { confirmed: true })).toMatchObject({
      kind: 'ok',
    });
    expect(await door.post(desk, '/actions', tap, {}, { confirmed: true })).toMatchObject({
      kind: 'refused',
      reason: 'tag_invalid',
    });
    expect(pass.id).toBeTruthy();
  });
});
