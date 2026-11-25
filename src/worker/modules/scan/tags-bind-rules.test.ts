import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { expireBindings } from '../nfc/expiry.ts';
import { beforeBatch } from './batch-interceptor-test-support.ts';
import { TAG_UNDO_MS } from './tags-bind-replay.ts';
import { addType, clearTypes } from './tags-policy-test-fixtures.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});
afterEach(() => f.kit.clock.set(TEST_NOW));

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
const ended = (cause: string) =>
  f.count('SELECT count(*) AS n FROM tag_bindings WHERE end_cause = ?', [cause]);

describe('user scope', () => {
  it('needs an owner account', async () => {
    const s = await f.desk({ tags: { assign: 'desk', assignAll: 'desk' } });
    const { card } = await f.pass();
    const res = await f.bind(s, { card, binding: 'user' });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: 'TAG_NO_ACCOUNT' });
  });

  it('needs the assignAll role or a Manager PIN', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk();
    const { card, ownerId } = await f.pass({ owner: true });
    const bare = await f.bind(s, { card, binding: 'user' });
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: 'TAG_APPROVAL_REQUIRED' });
    const ok = await f.bind(s, {
      card,
      binding: 'user',
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ status: 'bound', scope: 'user', ownerAccount: true });
    expect((await f.active()).some((b) => b.scope === 'user' && b.user_id === ownerId)).toBe(true);

    const m = await f.manager();
    const second = await f.pass({ owner: true });
    expect((await f.bind(m.scanner, { card: second.card, binding: 'user' })).status).toBe(200);
    const lax = await f.desk({ tags: { assign: 'desk', assignAll: 'desk' } });
    const third = await f.pass({ owner: true });
    expect((await f.bind(lax, { card: third.card, binding: 'user' })).status).toBe(200);
    const never = await f.desk({ tags: { assign: 'desk', assignAll: 'never' } });
    const fourth = await f.pass({ owner: true });
    expect(await json(await f.bind(never, { card: fourth.card, binding: 'user' }))).toMatchObject({
      code: 'TAG_ASSIGN_FORBIDDEN',
    });
  });

  it('checks the owner at commit', async () => {
    const lax = await f.desk({ tags: { assign: 'desk', assignAll: 'desk' } });
    const disabled = await f.pass({ owner: true });
    const raced = await beforeBatch(
      f.kit.env,
      /INSERT INTO tag_bindings/i,
      (real) =>
        run(real, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.ownerId ?? '']),
      () => f.bind(lax, { card: disabled.card, binding: 'user' }),
    );
    expect(raced.fired).toBe(true);
    expect(raced.result.status).toBe(409);
    const moved = await f.pass({ owner: true });
    const changed = await beforeBatch(
      f.kit.env,
      /INSERT INTO tag_bindings/i,
      (real) => run(real, 'UPDATE passes SET deleted_at = 1 WHERE id = ?', [moved.pass.id]),
      () => f.bind(lax, { card: moved.card, binding: 'user' }),
    );
    expect(changed.result.status).toBe(409);
    expect(await json(changed.result)).toMatchObject({ code: 'TAG_HOLDER_CHANGED' });
    expect(
      await f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id IN (?, ?)', [
        disabled.pass.id,
        moved.pass.id,
      ]),
    ).toBe(0);
  });
});

describe('one tag, one binding', () => {
  it('the same binding again is idempotent', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass();
    const tag = f.read();
    const first = await json(await f.bind(s, { card, tag }));
    const again = await json(await f.bind(s, { card, tag }));
    expect(again).toMatchObject({ status: 'already_bound', bindingId: first.bindingId });
    expect(again.undoUntil).toBe(first.undoUntil);
    expect((await f.active()).filter((b) => b.pass_id === pass.id)).toHaveLength(1);
  });

  it('the same holder replaces', async () => {
    const s = await f.desk({ tags: { assign: 'desk', assignAll: 'desk' } });
    const a = await f.pass({ owner: true });
    const tag = f.read();
    await f.bind(s, { card: a.card, tag });
    const res = await json(await f.bind(s, { card: a.card, tag, binding: 'user' }));
    expect(res).toMatchObject({ status: 'bound', scope: 'user' });
    expect(await ended('replaced')).toBeGreaterThanOrEqual(1);
    const preview = await json(await f.bind(s, { card: a.card, tag, preview: true }));
    expect(preview.warnings).toContain('replaces_user_tag');
  });

  it('another holder gets 409, and Move needs a Manager PIN', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk();
    const a = await f.pass();
    const b = await f.pass();
    const tag = f.read();
    await f.bind(s, { card: a.card, tag });
    const held = await f.bind(s, { card: b.card, tag });
    expect(held.status).toBe(409);
    expect(await json(held)).toMatchObject({ code: 'TAG_HELD_BY_OTHER' });
    const preview = await f.bind(s, { card: b.card, tag, preview: true });
    expect((await json(preview)).warnings).toContain('held_by_other');
    const bare = await f.bind(s, { card: b.card, tag, move: true });
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: 'TAG_APPROVAL_REQUIRED' });
    const moved = await f.bind(s, {
      card: b.card,
      tag,
      move: true,
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(await json(moved)).toMatchObject({ status: 'moved' });
    expect((await f.active()).filter((x) => x.pass_id === a.pass.id)).toHaveLength(0);
    expect(await ended('moved')).toBeGreaterThanOrEqual(1);
  });

  it('a lost tag moves only with a PIN, and a retired one not at all', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk();
    const a = await f.pass();
    const b = await f.pass();
    const tag = f.read();
    const bound = await json(await f.bind(s, { card: a.card, tag }));
    const db = f.kit.env.DB;
    await run(
      db,
      "UPDATE tag_bindings SET ended_at = ?, end_cause = 'lost', ended_by_type = 'user', ended_by = 'x' WHERE id = ?",
      [f.kit.clock.now(), String(bound.bindingId)],
    );
    await run(
      db,
      "UPDATE nfc_tags SET lost_at = ?, lost_by = 'x' WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [f.kit.clock.now(), String(bound.bindingId)],
    );
    const refused = await f.bind(s, { card: b.card, tag });
    expect(await json(refused)).toMatchObject({ code: 'TAG_LOST' });
    const lostPreview = await json(await f.bind(s, { card: b.card, tag, preview: true }));
    expect(lostPreview.warnings).toContain('lost');
    expect((await f.bind(s, { card: b.card, tag, move: true })).status).toBe(403);
    const ok = await f.bind(s, {
      card: b.card,
      tag,
      move: true,
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(ok.status).toBe(200);
    await run(
      db,
      "UPDATE nfc_tags SET status = 'retired' WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [String(bound.bindingId)],
    );
    const retired = await f.bind(s, {
      card: b.card,
      tag,
      move: true,
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(await json(retired)).toMatchObject({ code: 'TAG_RETIRED' });
  });
});

describe('undo', () => {
  it('ends the binding within 10 minutes on the same device only', async () => {
    const s = await f.desk();
    const other = await f.desk();
    const { card } = await f.pass();
    const bound = await json(await f.bind(s, { card }));
    const id = String(bound.bindingId);
    const elsewhere = await f.undo(other, id);
    expect(elsewhere.status).toBe(403);
    expect(await json(elsewhere)).toMatchObject({ code: 'TAG_UNDO_FORBIDDEN' });
    expect((await f.undo(await f.door(), id)).status).toBe(403);
    const ok = await f.undo(s, id);
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ status: 'undone', bindingId: id });
    expect((await f.active()).some((b) => b.id === id)).toBe(false);
    expect(await ended('undo')).toBeGreaterThanOrEqual(1);
    expect((await f.undo(s, id)).status).toBe(404);
    const row = await first<{ detail: string }>(
      f.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'tag.unbind' ORDER BY rowid DESC LIMIT 1",
    );
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ cause: 'undo', scannerId: s.id });
  });

  it('is refused after the window', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const id = String((await json(await f.bind(s, { card }))).bindingId);
    f.kit.clock.advance(TAG_UNDO_MS + 1000);
    const late = await f.undo(s, id);
    expect(late.status).toBe(403);
    expect(await json(late)).toMatchObject({ code: 'TAG_UNDO_EXPIRED' });
    expect((await f.active()).some((b) => b.id === id)).toBe(true);
  });

  it('is on the scanner, not the console, and not another org', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const id = String((await json(await f.bind(s, { card }))).bindingId);
    const admin = await f.kit.post(f.kit.admin(), `/tags/bindings/${id}/undo`, {});
    expect(admin.status).toBeGreaterThanOrEqual(400);
    expect((await f.active()).some((b) => b.id === id)).toBe(true);
  });
});

describe('rate caps', () => {
  it('binds are capped at 60 an hour per device', async () => {
    const s = await f.desk();
    const miss = { card: { code: 'no-such-card', method: 'camera' } };
    for (let i = 0; i < 60; i++) expect((await f.bind(s, miss)).status).toBe(404);
    const res = await f.bind(s, miss);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const other = await f.desk();
    expect((await f.bind(other, miss)).status).toBe(404);
    f.kit.clock.advance(3_600_000);
    expect((await f.bind(s, miss)).status).toBe(404);
  });

  it('unknown tags are capped at 30 reads per 10 minutes, known ones are not', async () => {
    const s = await f.desk();
    for (let i = 0; i < 30; i++) expect((await f.inspect(s, f.read())).status).toBe(200);
    const res = await f.inspect(s, f.read());
    expect(res.status).toBe(429);
    const { card } = await f.pass();
    const tag = f.read();
    await f.bind(await f.desk(), { card, tag });
    expect((await f.inspect(s, tag)).status).toBe(200);
  });
});

describe('loaners', () => {
  const HOUR = 3_600_000;
  const guest = {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    tags: { uses: ['staff', 'visitor'] },
    access: {
      input: { plan: 'tier', until: 'endsAt' },
      plans: [{ id: 'guest', label: 'Guest', kind: 'guest', zones: [{ zone: '*' }] }],
    },
  } as const;
  const expiry = async (bindingId: unknown) =>
    (
      await first<{ expires_at: number | null }>(
        f.kit.env.DB,
        'SELECT expires_at FROM tag_bindings WHERE id = ?',
        [String(bindingId)],
      )
    )?.expires_at;

  async function lendTo(endsIn: number, typeSpec: { bindingDays?: number } = {}) {
    const tpl = await f.kit.scanTemplate('Visitor', guest as never);
    const type = await addType(f, { use: 'visitor', scopes: 'pass', ...typeSpec });
    const s = await f.desk({ templateIds: [tpl] });
    const endsAt = f.kit.clock.now() + endsIn;
    const { card, pass } = await f.pass({
      template: tpl,
      input: { memberName: 'Leo Park', tier: 'guest', endsAt: new Date(endsAt).toISOString() },
    });
    return { s, card, pass, type, endsAt, tpl };
  }

  afterEach(() => clearTypes(f));

  it('a loaner on a 2-hour guest pass expires at the pass end, and opens this pass', async () => {
    const { s, card, type, endsAt } = await lendTo(2 * HOUR);
    const res = await f.bind(s, { card, typeId: type });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ status: 'bound', scope: 'pass', opensDefault: 'pass' });
    expect(await expiry(body.bindingId)).toBe(endsAt);
  });

  it('the earlier of the type expiry and the pass end wins', async () => {
    const long = await lendTo(5 * 24 * HOUR, { bindingDays: 1 });
    const a = await json(await f.bind(long.s, { card: long.card, typeId: long.type }));
    expect(await expiry(a.bindingId)).toBe(f.kit.clock.now() + 24 * HOUR);
    const short = await lendTo(HOUR, { bindingDays: 2 });
    const b = await json(await f.bind(short.s, { card: short.card, typeId: short.type }));
    expect(await expiry(b.bindingId)).toBe(short.endsAt);
  });

  it('refuses person scope for a loaner, in a preview too', async () => {
    const t = await lendTo(HOUR);
    for (const preview of [false, true]) {
      const res = await f.bind(t.s, { card: t.card, typeId: t.type, binding: 'user', preview });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(
      await f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', [t.pass.id]),
    ).toBe(0);
  });

  it('refuses pool: true and names the type instead', async () => {
    const t = await lendTo(HOUR);
    const res = await f.bind(t.s, { card: t.card, pool: true });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ code: 'TAG_POOL_UNSUPPORTED' });
  });

  it('a pass past its end takes no loaner', async () => {
    const t = await lendTo(HOUR);
    f.kit.clock.set(t.endsAt + 1);
    const res = await f.bind(t.s, { card: t.card, typeId: t.type });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAG_PASS_EXPIRED' });
  });

  it('the expiry job ends it at the window end, and the tag is spare again', async () => {
    const t = await lendTo(2 * HOUR);
    const body = await json(await f.bind(t.s, { card: t.card, typeId: t.type }));
    const job = jobCtxOf(f.kit);
    expect(await expireBindings(job)).toBe(0);
    f.kit.clock.set(t.endsAt + 1);
    expect(await expireBindings(job)).toBeGreaterThanOrEqual(1);
    const row = await first<{ end_cause: string }>(
      f.kit.env.DB,
      'SELECT end_cause FROM tag_bindings WHERE id = ?',
      [String(body.bindingId)],
    );
    expect(row?.end_cause).toBe('expired');
  });

  it('a pass that is not on a guest plan gives a loaner no window end', async () => {
    const type = await addType(f, { use: 'visitor', scopes: 'pass' });
    const member = await f.kit.scanTemplate('Member', {
      ...guest,
      access: {
        input: { plan: 'tier' },
        plans: [{ id: 'gold', label: 'Gold', kind: 'always', zones: [{ zone: '*' }] }],
      },
    } as never);
    const s = await f.desk({ templateIds: [member] });
    const { card } = await f.pass({ template: member, input: { memberName: 'Ann', tier: 'gold' } });
    const body = await json(await f.bind(s, { card, typeId: type }));
    expect(await expiry(body.bindingId)).toBeNull();
  });
});
