import { beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { TagType } from '../../../shared/contracts/nfc-tag-admin.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { all, first, run } from '../../platform/db.ts';
import { createAuthStores } from '../../stores.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { tagFixture } from './tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  f = await tagFixture();
  app = createApp({ stores: (env) => createAuthStores(env, f.kit.clock), clock: f.kit.clock });
});

async function member(orgId: string, roles: OrgRole[]) {
  const user = await makeUser(f.kit.fx);
  await grantKitMembership(f.kit, orgId, user.id, roles);
  return (await makeSession(f.kit.fx, { userId: user.id, roles: ['user'] })).headers;
}

async function template(orgId: string) {
  const id = f.kit.fx.ids.id();
  await run(
    f.kit.env.DB,
    `INSERT INTO templates (id, org_id, slug, name, origin, active_version, shared, created_at, updated_at)
     VALUES (?, ?, ?, 'T', 'uploaded', 1, 0, 1, 1)`,
    [id, orgId, id],
  );
  return id;
}

const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1/nfc/tag-types${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    f.kit.env,
  );

async function setup() {
  const org = await makeOrg(f.kit.fx);
  const admin = await member(org.id, ['org_admin']);
  return { org, admin };
}

describe('tag type CRUD', () => {
  it('creates, lists, updates with the version it read, and refuses a stale one', async () => {
    const { org, admin } = await setup();
    const tpl = await template(org.id);
    const created = await call(admin, 'POST', `?orgId=${org.id}`, {
      name: 'Member wristband',
      use: 'member',
      templateIds: [tpl],
    });
    expect(created.status).toBe(201);
    const type = (await created.json()) as TagType;
    expect(type).toMatchObject({
      system: 'uid',
      version: 1,
      perPass: 1,
      tagCount: 0,
      templateIds: [tpl],
      archivedAt: null,
    });
    const list = (await (await call(admin, 'GET', `?orgId=${org.id}`)).json()) as {
      items: TagType[];
    };
    expect(list.items.map((t) => t.id)).toEqual([type.id]);

    const patched = await call(admin, 'PATCH', `/${type.id}`, {
      version: 1,
      name: 'Wristband',
      perPass: 2,
      bindingDays: 30,
      templateIds: [],
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      name: 'Wristband',
      perPass: 2,
      bindingDays: 30,
      version: 2,
      templateIds: [],
    });
    const stale = await call(admin, 'PATCH', `/${type.id}`, { version: 1, name: 'Late' });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(
      await first(
        f.kit.env.DB,
        'SELECT action FROM audit_log WHERE target_id = ? ORDER BY rowid DESC',
        [type.id],
      ),
    ).toEqual({ action: 'nfc.tag_type.update' });
  });

  it('refuses a taken name and Secure typed IDs; a Secure type needs no typed IDs', async () => {
    const { org, admin } = await setup();
    const body = { name: 'Badge', use: 'staff' };
    expect((await call(admin, 'POST', `?orgId=${org.id}`, body)).status).toBe(201);
    const dupe = await call(admin, 'POST', `?orgId=${org.id}`, body);
    expect(dupe.status).toBe(409);
    expect(await dupe.json()).toMatchObject({ code: 'TAG_TYPE_NAME_TAKEN' });
    const secure = { ...body, name: 'Secure', system: 'sun', typed: false };
    const made = await call(admin, 'POST', `?orgId=${org.id}`, secure);
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ system: 'sun', typed: false });
    expect(
      (await call(admin, 'POST', `?orgId=${org.id}`, { ...body, name: 'S', system: 'sun' })).status,
    ).toBe(422);
  });

  it('a visitor type takes pass scope only, on create and on update', async () => {
    const { org, admin } = await setup();
    const q = `?orgId=${org.id}`;
    const bad = await call(admin, 'POST', q, { name: 'Loaner', use: 'visitor' });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'TAG_TYPE_LOANER_SCOPE' });
    const made = await call(admin, 'POST', q, { name: 'Loaner', use: 'visitor', scopes: 'pass' });
    expect(made.status).toBe(201);
    const type = (await made.json()) as TagType;
    const wide = await call(admin, 'PATCH', `/${type.id}${q}`, { version: 1, scopes: 'both' });
    expect(wide.status).toBe(422);
    expect(await wide.json()).toMatchObject({ code: 'TAG_TYPE_LOANER_SCOPE' });
    const rename = await call(admin, 'PATCH', `/${type.id}${q}`, { version: 1, name: 'Loan' });
    expect(rename.status).toBe(200);
    const member = await call(admin, 'POST', q, { name: 'Badge', use: 'member' });
    const other = (await member.json()) as TagType;
    const turned = await call(admin, 'PATCH', `/${other.id}${q}`, { version: 1, use: 'visitor' });
    expect(turned.status).toBe(422);
    expect(await turned.json()).toMatchObject({ code: 'TAG_TYPE_LOANER_SCOPE' });
    expect(
      (
        await call(admin, 'PATCH', `/${other.id}${q}`, {
          version: 1,
          use: 'visitor',
          scopes: 'pass',
        })
      ).status,
    ).toBe(200);
  });

  it('pages the list by cursor', async () => {
    const { org, admin } = await setup();
    for (const name of ['A', 'B', 'C'])
      await call(admin, 'POST', `?orgId=${org.id}`, { name, use: 'member' });
    const first = (await (await call(admin, 'GET', `?orgId=${org.id}&limit=2`)).json()) as {
      items: TagType[];
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(2);
    const next = (await (
      await call(admin, 'GET', `?orgId=${org.id}&limit=2&cursor=${first.nextCursor}`)
    ).json()) as { items: TagType[]; nextCursor: string | null };
    expect(next.items).toHaveLength(1);
    expect([...first.items, ...next.items].map((t) => t.name).sort()).toEqual(['A', 'B', 'C']);
    expect(next.nextCursor).toBeNull();
  });

  it('creates, updates and archives a sun type', async () => {
    const { org, admin } = await setup();
    const made = await call(admin, 'POST', `?orgId=${org.id}`, {
      name: 'Badge',
      use: 'staff',
      system: 'sun',
      typed: false,
    });
    expect(made.status).toBe(201);
    const type = (await made.json()) as TagType;
    expect(type).toMatchObject({ system: 'sun', typed: false });
    const res = await call(admin, 'PATCH', `/${type.id}`, {
      version: type.version,
      name: 'Badge 2',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ system: 'sun', name: 'Badge 2', version: 2 });
    const typed = await call(admin, 'PATCH', `/${type.id}`, { version: 2, typed: true });
    expect(typed.status).toBe(422);
  });

  it('refuses a template of another org on create and on update', async () => {
    const { org, admin } = await setup();
    const other = await makeOrg(f.kit.fx);
    const foreign = await template(other.id);
    const bad = await call(admin, 'POST', `?orgId=${org.id}`, {
      name: 'X',
      use: 'member',
      templateIds: [foreign],
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'UNKNOWN_TEMPLATE' });
    const ok = (await (
      await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Y', use: 'member' })
    ).json()) as TagType;
    const upd = await call(admin, 'PATCH', `/${ok.id}`, { version: 1, templateIds: [foreign] });
    expect(upd.status).toBe(422);
    expect(
      await all(f.kit.env.DB, 'SELECT 1 FROM nfc_tag_type_templates WHERE template_id = ?', [
        foreign,
      ]),
    ).toEqual([]);
  });

  it('archives a type and keeps its tags; no more edits', async () => {
    const { org, admin } = await setup();
    const type = (await (
      await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Gone', use: 'member' })
    ).json()) as TagType;
    const tag = f.kit.fx.ids.id();
    await run(
      f.kit.env.DB,
      `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, created_at)
       VALUES (?, ?, 'live', ?, 'uid', ?, 'ABCD', 1)`,
      [tag, org.id, `abcd${'0'.repeat(60)}`, type.id],
    );
    const res = await call(admin, 'POST', `/${type.id}/archive`, { version: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tagCount: 1, version: 2 });
    expect(
      await first(f.kit.env.DB, 'SELECT type_id, status FROM nfc_tags WHERE id = ?', [tag]),
    ).toEqual({ type_id: type.id, status: 'active' });
    const edit = await call(admin, 'PATCH', `/${type.id}`, { version: 2, name: 'Back' });
    expect(edit.status).toBe(409);
    expect(await edit.json()).toMatchObject({ code: 'TAG_TYPE_ARCHIVED' });
    // The name is free again.
    expect(
      (await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Gone', use: 'member' })).status,
    ).toBe(201);
  });
});

describe('tag type access', () => {
  it('needs scanning:manage to change and scanning:read to view; other orgs read as absent', async () => {
    const { org, admin } = await setup();
    const reader = await member(org.id, ['pass_operator']);
    const outsider = (await setup()).admin;
    const type = (await (
      await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Acc', use: 'member' })
    ).json()) as TagType;
    expect((await call(reader, 'GET', `?orgId=${org.id}`)).status).toBe(200);
    expect(
      (await call(reader, 'POST', `?orgId=${org.id}`, { name: 'Z', use: 'member' })).status,
    ).toBe(403);
    expect((await call(reader, 'PATCH', `/${type.id}`, { version: 1, name: 'Z' })).status).toBe(
      403,
    );
    expect((await call(outsider, 'GET', `?orgId=${org.id}`)).status).toBe(404);
    expect((await call(outsider, 'PATCH', `/${type.id}`, { version: 1, name: 'Z' })).status).toBe(
      404,
    );
    expect((await call(outsider, 'POST', `/${type.id}/archive`, { version: 1 })).status).toBe(404);
    expect(
      await first(f.kit.env.DB, 'SELECT name, version FROM nfc_tag_types WHERE id = ?', [type.id]),
    ).toEqual({ name: 'Acc', version: 1 });
  });

  it('a key reads with scans:read and changes with scanning:write, in its own org only', async () => {
    const { org, admin } = await setup();
    const other = await makeOrg(f.kit.fx);
    const type = (await (
      await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Key', use: 'member' })
    ).json()) as TagType;
    const key = (scopes: string[], orgId: string | null = org.id) =>
      makeApiKey(f.kit.fx, { orgId, scopes }).then((k) => k.headers);
    const read = await key(['scans:read']);
    const write = await key(['scanning:write']);
    const none = await key(['passes:read']);
    const elsewhere = await key(['scans:read', 'scanning:write'], other.id);

    expect((await call(read, 'GET', '')).status).toBe(200);
    expect((await call(read, 'POST', '', { name: 'K2', use: 'member' })).status).toBe(403);
    expect((await call(read, 'PATCH', `/${type.id}`, { version: 1, name: 'K' })).status).toBe(403);
    expect((await call(none, 'GET', '')).status).toBe(403);
    expect((await call(write, 'POST', '', { name: 'K2', use: 'member' })).status).toBe(201);
    expect((await call(write, 'PATCH', `/${type.id}`, { version: 1, name: 'K' })).status).toBe(200);
    expect((await call(elsewhere, 'PATCH', `/${type.id}`, { version: 2, name: 'No' })).status).toBe(
      404,
    );
    expect((await call(elsewhere, 'GET', `?orgId=${org.id}`)).status).toBe(403);
  });

  it('answers 404 to a platform key on a tag type by id', async () => {
    const { org, admin } = await setup();
    const type = (await (
      await call(admin, 'POST', `?orgId=${org.id}`, { name: 'Plat', use: 'member' })
    ).json()) as TagType;
    const platform = (await makeApiKey(f.kit.fx, { orgId: null, scopes: ['scanning:write'] }))
      .headers;
    expect((await call(platform, 'PATCH', `/${type.id}`, { version: 1, name: 'No' })).status).toBe(
      404,
    );
  });
});
