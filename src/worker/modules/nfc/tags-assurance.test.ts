import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { bindTag } from './tags.ts';
import { reportTagLost, restoreTag } from './tags-admin.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
beforeAll(async () => {
  f = await tagFixture({ releases: true });
});

const raiseMinimum = async () => {
  await run(f.kit.env.DB, 'DROP TRIGGER IF EXISTS template_versions_immutable');
  await run(
    f.kit.env.DB,
    'UPDATE template_versions SET manifest = json_set(manifest, \'$.scan\', json(\'{"actions":[{"id":"check_in","label":"Check in","kind":"check_in"}],"tags":{"min":"secure"}}\')) WHERE template_id = ?',
    [f.kit.template.id],
  );
};

describe('console tags and the template minimum', () => {
  it('refuses a restore and a bind once the template needs a secure tag', async () => {
    const t = await f.org();
    const authority = await t.authority();
    const pass = await f.pass(t.org.id);
    const { tag } = await bindTag(f.kit.ctx, authority, {
      uid: f.nextUid(),
      passId: pass.id,
      scope: 'pass',
    });
    await reportTagLost(f.kit.ctx, authority, tag.id);
    await raiseMinimum();
    await expect(restoreTag(f.kit.ctx, authority, tag.id)).rejects.toMatchObject({
      code: 'TAG_ASSURANCE_LOW',
    });
    await expect(
      bindTag(f.kit.ctx, authority, { uid: f.nextUid(), passId: pass.id, scope: 'pass' }),
    ).rejects.toMatchObject({ code: 'TAG_ASSURANCE_LOW' });
  });
});
