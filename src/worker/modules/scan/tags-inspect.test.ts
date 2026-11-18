import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';

let f: TagScanFixture;
beforeAll(async () => {
  f = await tagScanFixture();
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('inspect a tag', () => {
  it('a tag nobody has seen is new, and it is not stored', async () => {
    const s = await f.desk();
    const body = await json(await f.inspect(s, f.read()));
    expect(body).toMatchObject({ state: 'new', assurance: 'basic', bound: null });
    expect(body.hint).toMatch(/^[0-9A-F]{4}$/);
    expect(await f.count('SELECT count(*) AS n FROM nfc_tags')).toBe(0);
  });

  it('a bound tag says what it works with and who assigned it', async () => {
    const s = await f.desk();
    const { pass, card } = await f.pass();
    const tag = f.read();
    await f.bind(s, { card, tag });
    const body = await json(await f.inspect(s, tag));
    expect(body).toMatchObject({
      state: 'bound',
      bound: { scope: 'pass', passTitle: pass.displayTitle ?? '' },
    });
    expect(body.boundAt).toBe(f.kit.clock.now());
  });

  it('an unassigned tag that was seen is new; a lost one carries its date', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const tag = f.read();
    const bound = await json(await f.bind(s, { card, tag }));
    const db = f.kit.env.DB;
    const id = String(bound.bindingId);
    await run(
      db,
      "UPDATE tag_bindings SET ended_at = ?, end_cause = 'admin', ended_by_type = 'user', ended_by = 'x' WHERE id = ?",
      [f.kit.clock.now(), id],
    );
    expect(await json(await f.inspect(s, tag))).toMatchObject({ state: 'new' });
    await run(
      db,
      "UPDATE nfc_tags SET lost_at = 5, lost_by = 'x' WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [id],
    );
    expect(await json(await f.inspect(s, tag))).toMatchObject({ state: 'lost', lostAt: 5 });
    await run(
      db,
      "UPDATE nfc_tags SET status = 'retired' WHERE id = (SELECT tag_id FROM tag_bindings WHERE id = ?)",
      [id],
    );
    expect(await json(await f.inspect(s, tag))).toMatchObject({ state: 'retired' });
  });

  it('a random UID or a read with no UID is invalid', async () => {
    const s = await f.desk();
    expect(await json(await f.inspect(s, f.read('08aabbcc')))).toMatchObject({
      state: 'invalid',
      hint: null,
    });
    expect(await json(await f.inspect(s, { ...f.read(), uidRandom: true }))).toMatchObject({
      state: 'invalid',
    });
    const ndef = { tech: 'a', source: 'native', ndef: { type: 'T', value: 'x' } };
    expect(await json(await f.inspect(s, ndef))).toMatchObject({ state: 'invalid' });
  });

  it('is not allowed while the org switch is off', async () => {
    const off = await tagScanFixture({ enabled: false });
    const s = await off.desk();
    expect(await json(await off.inspect(s, off.read()))).toMatchObject({ state: 'not_allowed' });
  });

  it('is Desk and up, on a scanner', async () => {
    const door = await f.door();
    expect((await f.inspect(door, f.read())).status).toBe(403);
    const admin = await f.kit.post(f.kit.admin(), '/tags/inspect', { tag: f.read() });
    expect(admin.status).toBeGreaterThanOrEqual(400);
  });

  it('never leaks another org or mode', async () => {
    const s = await f.desk();
    const { card } = await f.pass();
    const tag = f.read();
    await f.bind(s, { card, tag });
    const test = await f.kit.scanner({
      mode: 'test',
      templateIds: [f.tpl],
      settings: { roleWithoutSignIn: 'desk' },
    });
    expect(await json(await f.inspect(test, tag))).toMatchObject({ state: 'new' });
  });
});
