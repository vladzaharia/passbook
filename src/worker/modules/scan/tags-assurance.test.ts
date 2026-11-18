import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { type TagScanFixture, tagScanFixture } from './tags-scan-test-fixtures.ts';
import { key } from './test-kit.ts';

let f: TagScanFixture;
let secure: string;
beforeAll(async () => {
  f = await tagScanFixture();
  secure = await f.kit.scanTemplate('Staff badge', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    tags: { min: 'secure' },
  });
});

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('template tag minimum', () => {
  it('refuses to bind a Basic tag to a pass whose template needs a secure one', async () => {
    const s = await f.desk({ templateIds: [f.tpl, secure] });
    const { card } = await f.pass({ template: secure });
    const res = await f.bind(s, { card });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'TAG_ASSURANCE_LOW' });
    expect((await f.active()).length).toBe(0);
  });

  it('refuses admission on a Basic tag once the template needs a secure one', async () => {
    const s = await f.desk({ templateIds: [f.tpl] });
    const { card } = await f.pass();
    const tag = f.read();
    expect((await f.bind(s, { card, tag })).status).toBe(200);
    const resolve = async () =>
      json(
        await f.kit.post(s.headers, '/resolve', {
          idempotencyKey: key(),
          input: { tag, method: 'nfc' },
          clientTs: f.kit.clock.now(),
        }),
      );
    expect(await resolve()).toMatchObject({ kind: 'ready' });
    await run(f.kit.env.DB, 'DROP TRIGGER template_versions_immutable');
    await run(
      f.kit.env.DB,
      'UPDATE template_versions SET manifest = json_set(manifest, \'$.scan.tags\', json(\'{"min":"secure"}\')) WHERE template_id = ?',
      [f.tpl],
    );
    expect(await resolve()).toMatchObject({ kind: 'refused', reason: 'tag_not_allowed' });
  });

  it('leaves a template without a minimum unchanged', async () => {
    const s = await f.desk({ templateIds: [f.otherTpl] });
    const { card } = await f.pass({ template: f.otherTpl });
    expect((await f.bind(s, { card })).status).toBe(200);
  });
});
