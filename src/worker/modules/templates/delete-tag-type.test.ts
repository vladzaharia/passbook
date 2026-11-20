import { beforeAll, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { tagFixture } from '../nfc/tags-test-fixtures.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  f = await tagFixture();
  app = createApp({ stores: (env) => createAuthStores(env, f.kit.clock), clock: f.kit.clock });
});

it('refuses to delete a template a tag type names, with its own error, and keeps the template', async () => {
  const db = f.kit.env.DB;
  const org = await makeOrg(f.kit.fx);
  const user = await makeUser(f.kit.fx);
  await grantKitMembership(f.kit, org.id, user.id, ['org_admin']);
  const { headers } = await makeSession(f.kit.fx, { userId: user.id, roles: ['user'] });
  const templateId = f.kit.fx.ids.id();
  const typeId = f.kit.fx.ids.id();
  await run(
    db,
    `INSERT INTO templates (id, org_id, slug, name, origin, active_version, shared, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Named', 'uploaded', 1, 0, 'active', 1, 1)`,
    [templateId, org.id, templateId],
  );
  await run(
    db,
    `INSERT INTO nfc_tag_types (id, org_id, name, system, use, created_at, created_by, updated_at)
     VALUES (?, ?, 'Wristband', 'uid', 'member', 1, 'x', 1)`,
    [typeId, org.id],
  );
  await run(db, 'INSERT INTO nfc_tag_type_templates (type_id, template_id) VALUES (?, ?)', [
    typeId,
    templateId,
  ]);
  const res = await app.request(
    `https://wallet.test/api/v1/templates/${templateId}`,
    { method: 'DELETE', headers },
    f.kit.env,
  );
  expect(res.status).toBe(409);
  const problem = (await res.json()) as { code: string; detail: string };
  expect(problem.code).toBe('TEMPLATE_IN_TAG_TYPE');
  expect(problem.detail).not.toMatch(/pass/i);
  expect(await first(db, 'SELECT status FROM templates WHERE id = ?', [templateId])).toEqual({
    status: 'active',
  });
});
