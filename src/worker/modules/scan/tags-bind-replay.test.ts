import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('a retried bind', () => {
  it('replays the stored answer, even after Undo, and binds nothing again', async () => {
    const s = await f.desk();
    const { card, pass } = await f.pass();
    const body = { idempotencyKey: key(), card, tag: f.read() };
    const first = await json(await f.bind(s, body));
    expect(first.status).toBe('bound');
    await f.undo(s, String(first.bindingId));
    const retry = await json(await f.bind(s, body));
    expect(retry).toMatchObject({ status: 'bound', bindingId: first.bindingId, undoUntil: null });
    expect(
      await f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', [pass.id]),
    ).toBe(1);
    expect((await f.active()).some((b) => b.pass_id === pass.id)).toBe(false);
  });

  it('refuses the same key for another request', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const k = key();
    await f.bind(s, { idempotencyKey: k, card, tag: f.read() });
    const other = await f.bind(s, { idempotencyKey: k, card, tag: f.read() });
    expect(other.status).toBe(409);
    expect(await json(other)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('answers 422 for a client pinned to PassBook-Version 2026-11-22', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const k = key();
    const pinned = { ...s, headers: { ...s.headers, 'PassBook-Version': '2026-11-22' } };
    await f.bind(pinned, { idempotencyKey: k, card, tag: f.read() });
    const other = await f.bind(pinned, { idempotencyKey: k, card, tag: f.read() });
    expect(other.status).toBe(422);
    expect(await json(other)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('inspect names', () => {
  it('only a pass this scanner takes', async () => {
    const pool = await f.desk({ templateIds: [f.otherTpl] });
    const gym = await f.desk();
    const { card } = await f.pass({ template: f.otherTpl });
    const tag = f.read();
    expect((await f.bind(pool, { card, tag })).status).toBe(200);
    const own = await json(await f.inspect(pool, tag));
    expect((own.bound as { passTitle: string }).passTitle).not.toBe('');
    const other = await json(await f.inspect(gym, tag));
    expect(other).toMatchObject({
      state: 'bound',
      bound: { scope: 'pass', passTitle: '', holderName: null },
      boundByName: null,
    });
  });
});

describe('a takeover of a lost tag', () => {
  it('Undo puts the lost report back', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk();
    const a = await f.pass();
    const b = await f.pass();
    const tag = f.read();
    const bound = await json(await f.bind(s, { card: a.card, tag }));
    const db = f.kit.env.DB;
    const id = String(bound.bindingId);
    const now = f.kit.clock.now();
    await run(
      db,
      "UPDATE tag_bindings SET ended_at = ?, end_cause = 'lost', ended_by_type = 'user', ended_by = 'x' WHERE id = ?",
      [now, id],
    );
    await run(
      db,
      "UPDATE nfc_tags SET lost_at = ?, lost_by = 'x' WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [now, id],
    );
    const take = await json(
      await f.bind(s, {
        card: b.card,
        tag,
        move: true,
        approval: { staffId: mgr.id, pin: mgr.pin },
      }),
    );
    const lostAt = () =>
      first<{ lost_at: number | null; lost_by: string | null }>(
        db,
        'SELECT lost_at, lost_by FROM nfc_tags WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)',
        [id],
      );
    expect((await lostAt())?.lost_at).toBeNull();
    expect((await f.undo(s, String(take.bindingId))).status).toBe(200);
    expect(await lostAt()).toEqual({ lost_at: now, lost_by: 'x' });
    const again = await f.bind(s, { card: b.card, tag });
    expect(await json(again)).toMatchObject({ code: 'TAG_LOST' });
  });
});

describe('audit of a staff bind', () => {
  it('names the scanner, with the staff id in the detail', async () => {
    const m = await f.manager();
    const { card } = await f.pass();
    const res = await json(await f.bind(m.scanner, { card }));
    const row = await first<{ actor_type: string; actor_id: string; detail: string }>(
      f.kit.env.DB,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'tag.bind' AND target_id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [String(res.bindingId)],
    );
    expect(row).toMatchObject({ actor_type: 'scanner', actor_id: m.scanner.id });
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ staffId: m.staff.id });
  });
});
