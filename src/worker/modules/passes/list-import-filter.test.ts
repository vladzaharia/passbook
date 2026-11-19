import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
} from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { listPasses } from './repo-list.ts';

let base: AppEnv;
beforeAll(async () => {
  base = await makeEnv();
});

async function seedImport(
  orgId: string,
  templateId: string,
  passIds: string[],
  result = 'created',
) {
  const id = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO pass_imports (id, org_id, mode, template_id, source_kind, source_name, state, created_by, created_at, expires_at)
     VALUES (?, ?, 'live', ?, 'file', 'people.csv', 'done', 'u', 1, 4000000000000)`,
    [id, orgId, templateId],
  );
  for (const [i, passId] of passIds.entries())
    await run(
      env.DB,
      `INSERT INTO pass_import_rows (import_id, row_no, action, pass_id, state, result) VALUES (?, ?, 'create', ?, 'done', ?)`,
      [id, i + 1, passId, result],
    );
  return id;
}

describe('pass list: from an import', () => {
  it('lists the passes an import made, and only within its own organization', async () => {
    const f = fixtures(base);
    const org = await makeOrg(f);
    const other = await makeOrg(f);
    const tpl = makeTemplate({ id: `imp-${f.ids.id()}`, orgId: org.id });
    const mine = await makePass(f, { orgId: org.id, template: tpl.resolved });
    await makePass(f, { orgId: org.id, template: tpl.resolved });
    const importId = await seedImport(org.id, tpl.resolved.id, [mine.id]);
    const page = await listPasses(env.DB, { orgId: org.id, mode: 'live', importId, limit: 10 });
    expect(page.items.map((p) => p.id)).toEqual([mine.id]);
    const elsewhere = await listPasses(env.DB, {
      orgId: other.id,
      mode: 'live',
      importId,
      limit: 10,
    });
    expect(elsewhere.items).toEqual([]);
  });

  it('leaves out rows that changed nothing', async () => {
    const f = fixtures(base);
    const org = await makeOrg(f);
    const tpl = makeTemplate({ id: `imp-${f.ids.id()}`, orgId: org.id });
    const same = await makePass(f, { orgId: org.id, template: tpl.resolved });
    const importId = await seedImport(org.id, tpl.resolved.id, [same.id], 'unchanged');
    const page = await listPasses(env.DB, { orgId: org.id, mode: 'live', importId, limit: 10 });
    expect(page.items).toEqual([]);
  });
});
