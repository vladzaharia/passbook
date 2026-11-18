import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { TAG_UNDO_MS } from './tags-bind.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('assign a tag on a scanner', () => {
  it('binds to the scanned pass, and Undo is offered for 10 minutes', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass();
    const res = await f.bind(s, { card });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({
      status: 'bound',
      scope: 'pass',
      assurance: 'basic',
      ownerAccount: false,
      card: { passId: pass.id, templateName: 'Gym card' },
      undoUntil: f.kit.clock.now() + TAG_UNDO_MS,
    });
    const row = (await f.active()).find((b) => b.pass_id === pass.id);
    expect(row).toMatchObject({ scope: 'pass', scanner_id: s.id, bound_by_type: 'scanner' });
    expect(
      await f.count(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'tag.bind' AND target_id IN (SELECT tag_id FROM tag_bindings WHERE id = ?)",
        [row?.id ?? ''],
      ),
    ).toBe(1);
  });

  it('a preview writes nothing and names the card', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass({ owner: true });
    const before = (await f.active()).length;
    const body = await json(await f.bind(s, { card, preview: true }));
    expect(body).toMatchObject({
      status: 'preview',
      bindingId: null,
      ownerAccount: true,
      card: { passId: pass.id },
    });
    expect((await f.active()).length).toBe(before);
  });

  it('is refused while the org switch is off', async () => {
    const off = await tagScanFixture({ enabled: false });
    const s = await off.desk();
    const { card } = await off.pass();
    const res = await off.bind(s, { card });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAGS_OFF' });
  });

  it('refuses a random UID and a read with no UID', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const random = await f.bind(s, { card, tag: f.read('08aabbcc') });
    expect(await json(random)).toMatchObject({ code: 'TAG_UID_RANDOM' });
    const flagged = await f.bind(s, { card, tag: { ...f.read(), uidRandom: true } });
    expect(await json(flagged)).toMatchObject({ code: 'TAG_UID_RANDOM' });
    const ndef = await f.bind(s, {
      card,
      tag: { tech: 'a', source: 'native', ndef: { type: 'T', value: 'x' } },
    });
    expect(ndef.status).toBe(422);
    expect(await json(ndef)).toMatchObject({ code: 'TAG_UNREADABLE' });
  });

  it('refuses a loaner tag', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    expect(await json(await f.bind(s, { card, pool: true }))).toMatchObject({
      code: 'TAG_POOL_UNSUPPORTED',
    });
  });
});

describe('who may assign', () => {
  it('refuses a Door role and an off setting', async () => {
    const { card } = await f.pass();
    const door = await f.door();
    const res = await f.bind(door, { card });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'TAG_ASSIGN_FORBIDDEN' });
    expect((await f.inspect(door, f.read())).status).toBe(403);
    const never = await f.desk({ tags: { assign: 'never', assignAll: 'never' } });
    expect(await json(await f.bind(never, { card }))).toMatchObject({
      code: 'TAG_ASSIGN_FORBIDDEN',
    });
  });

  it('refuses a paused scanning session', async () => {
    const s = await f.desk();
    const id = await f.workspace(f.kit, s, { templateIds: [f.tpl] });
    await run(f.kit.env.DB, "UPDATE scanning_sessions SET status = 'paused' WHERE id = ?", [id]);
    const { card } = await f.pass();
    const res = await f.bind(s, { card });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'SCANNING_SESSION_PAUSED' });
  });

  it('a role below the setting needs a Manager PIN', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk({ tags: { assign: 'manager', assignAll: 'manager' } });
    const { card } = await f.pass();
    const bare = await f.bind(s, { card });
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: 'TAG_APPROVAL_REQUIRED' });
    const ok = await f.bind(s, { card, approval: { staffId: mgr.id, pin: mgr.pin } });
    expect(ok.status).toBe(200);
    const row = await first<{ detail: string }>(
      f.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'tag.approve' ORDER BY rowid DESC LIMIT 1",
    );
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ approvedBy: mgr.id });
  });

  it('a till cannot approve', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.kit.scanner({
      templateIds: [f.tpl],
      kind: 'terminal',
      settings: { roleWithoutSignIn: 'desk' },
    });
    const { pass } = await f.pass();
    const res = await f.bind(s, {
      card: { passId: pass.id, method: 'manual' },
      approval: { staffId: mgr.id, pin: mgr.pin },
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'API_KEY_NO_APPROVAL' });
  });
});

describe('the card', () => {
  it('a lookup by pass id needs a Manager PIN; a signed-in Manager does not', async () => {
    const mgr = await f.kit.staff('manager');
    const s = await f.desk();
    const { pass } = await f.pass();
    const card = { passId: pass.id, method: 'manual' as const };
    const bare = await f.bind(s, { card });
    expect(bare.status).toBe(403);
    expect(await json(bare)).toMatchObject({ code: 'TAG_APPROVAL_REQUIRED' });
    expect(
      await f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', [pass.id]),
    ).toBe(0);
    const wrong = await f.bind(s, { card, approval: { pin: '000000' } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(
      await f.count('SELECT count(*) AS n FROM tag_bindings WHERE pass_id = ?', [pass.id]),
    ).toBe(0);
    expect((await f.bind(s, { card, approval: { staffId: mgr.id, pin: mgr.pin } })).status).toBe(
      200,
    );
    const m = await f.manager();
    const second = await f.pass();
    expect(
      (await f.bind(m.scanner, { card: { passId: second.pass.id, method: 'manual' } })).status,
    ).toBe(200);
  });

  it('a typed code is a lookup, not possession', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const res = await f.bind(s, { card: { ...card, method: 'manual' } });
    expect(await json(res)).toMatchObject({ code: 'TAG_APPROVAL_REQUIRED' });
  });

  it('only passes the scanner accepts', async () => {
    const s = await f.desk();
    const { card } = await f.pass({ template: f.otherTpl });
    const res = await f.bind(s, { card });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'TAG_PASS_NOT_ACCEPTED' });
  });

  it('an unknown card is not found', async () => {
    const s = await f.desk();
    const res = await f.bind(s, { card: { code: 'no-such-card', method: 'camera' } });
    expect(res.status).toBe(404);
  });

  it('refuses a voided, removed or expired pass, and allows one that is not valid yet', async () => {
    const s = await f.desk();
    const db = f.kit.env.DB;
    const voided = await f.pass();
    await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [voided.pass.id]);
    expect(await json(await f.bind(s, { card: voided.card }))).toMatchObject({
      code: 'TAG_PASS_VOIDED',
    });
    const removed = await f.pass();
    await run(db, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
      f.kit.clock.now(),
      removed.pass.id,
    ]);
    expect(await json(await f.bind(s, { card: removed.card }))).toMatchObject({
      code: 'TAG_PASS_REMOVED',
    });
    const expired = await f.pass();
    await run(
      db,
      "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
      [new Date(f.kit.clock.now() - 3_600_000).toISOString(), expired.pass.id],
    );
    const res = await f.bind(s, { card: expired.card });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAG_PASS_EXPIRED' });
    const soon = await f.pass({
      input: { startsAt: new Date(f.kit.clock.now() + 86_400_000).toISOString() },
    });
    expect((await f.bind(s, { card: soon.card })).status).toBe(200);
  });
});
