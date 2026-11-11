/// <reference types="vite/client" />

import { unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  TemplateDetailSchema,
  TemplateListSchema,
  TemplateVersionDetailSchema,
  UploadListSchema,
} from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { crc32, sha1Hex } from './package/hash.ts';
import { createTemplateRegistry } from './registry.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets, importZip, templateAuthor } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const workflows: { id: string; params: unknown }[] = [];
let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let org: { id: string };
let admin: Record<string, string>;
let outsider: Record<string, string>;

const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = admin) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...headers, ...init.headers } },
    env,
  );
const post = (path: string, body: unknown = {}, headers: Record<string, string> = admin) =>
  call(
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    headers,
  );
const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});
const importVersion = (name: string, extra: Record<string, Uint8Array> = {}) =>
  importZip(env, clock, {
    orgId: org.id,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra })),
    name,
  });
const detailOf = async (id: string) =>
  TemplateDetailSchema.parse(await (await call(`/${id}`)).json());

async function seedPreviouslyPublished(id: string, version: string) {
  // Simulate a template published before the new release-approval requirement existed: the cutover
  // gave it a legacy release at its active version, the only release in the scope.
  await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [version, id]);
  await run(
    env.DB,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
       candidate_hash, content_hash, adapter_revision, adapter_capabilities,
       audience_policy_revision, source, action, created_at)
     VALUES (?, ?, ?, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', ?)`,
    [f.ids.id(), id, org.id, version, 'a'.repeat(64), 'b'.repeat(64), clock.now()],
  );
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  const assets = fakeAssets();
  const bakedFiles = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  const bytesFor = (slug: string, name: string) => {
    const data = bakedFiles[`../../../../templates/${slug}/${name}`];
    if (!data?.startsWith('data:') || !data.includes(';base64,'))
      throw new Error(`Missing baked fixture bytes: ${slug}/${name}`);
    return Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0));
  };
  for (const t of generatedSource.templates) {
    for (const a of t.assets) {
      const bytes = bytesFor(t.slug, a.name);
      if (bytes.length !== a.size || (await sha1Hex(bytes)) !== a.sha1 || crc32(bytes) !== a.crc32)
        throw new Error(`Baked fixture does not match generated metadata: ${t.slug}/${a.name}`);
      assets.files.set(a.source.path, bytes);
    }
    for (const extra of t.extras) {
      const bytes = bytesFor(t.slug, extra.name);
      if (bytes.length !== extra.size || (await sha1Hex(bytes)) !== extra.sha1)
        throw new Error(`Baked extra does not match generated metadata: ${t.slug}/${extra.name}`);
      assets.files.set(extra.path, bytes);
    }
  }
  env = await makeEnv({
    ASSETS: assets,
    BULK_REISSUE: {
      create: async (o: { id: string; params: unknown }) => {
        workflows.push(o);
        return { id: o.id };
      },
    } as unknown as Workflow,
    TEMPLATE_IMPORT: { create: async (o: { id: string }) => ({ id: o.id }) } as unknown as Workflow,
  });
  f = fixtures(env, clock);
  app = createApp({ stores: { ...auth.stores, sessions: createSessionStore(env, clock) }, clock });
  org = await makeOrg(f);
  const adminId = (await makeUser(f)).id;
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const roles = JSON.stringify(['org_admin']);
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, org.id, roles, f.ids.token(), now, now + 3600_000, now, adminId],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, org.id, adminId, invitationId, roles, now],
  );
  admin = (await makeSession(f, { userId: adminId, roles: ['admin', 'user'] })).headers;
  outsider = (
    await makeSession(f, {
      userId: (await makeUser(f)).id,
      roles: ['admin', 'user'],
    })
  ).headers;
}, 60_000);

describe('versions', () => {
  it('keeps existing passes on their published version until a separate release', async () => {
    const v1 = await importVersion('Counted Card');
    expect(v1.result).not.toBeNull();
    const id = v1.result?.templateId ?? '';
    await seedPreviouslyPublished(id, v1.result?.version ?? '');
    const t1 = await createTemplateRegistry(env).resolve(id);
    for (let i = 0; i < 3; i++) await makePass(f, { orgId: org.id, template: t1 });
    const v2 = await importVersion('Counted Card', { 'logo.png': makePng(100, 40) });
    expect(v2.result).not.toBeNull();
    expect(v2.result?.templateId).toBe(id);
    expect(v2.result?.version).not.toBe(t1.version);
    expect((await post(`/${id}/activate`, { version: v2.result?.version })).status).toBe(404);

    const draft = await detailOf(id);
    expect(draft.activeVersion).toBe(t1.version);
    expect((await createTemplateRegistry(env).resolve(id)).version).toBe(t1.version);
    expect(draft.versions.find((v) => v.version === t1.version)).toMatchObject({
      active: true,
      passCount: 3,
    });
    expect(draft.versions.find((v) => v.version === v2.result?.version)).toMatchObject({
      active: false,
      passCount: 0,
    });
    expect(draft.passesOnOlderVersions).toBe(0);
    expect(draft.passCount).toBe(3);
  });

  it('counts passes on older versions in a previously published template', async () => {
    const oldVersion = await importVersion('Historical Counted Card');
    const activeVersion = await importVersion('Historical Counted Card', {
      'logo.png': makePng(100, 40),
    });
    expect(oldVersion.result).not.toBeNull();
    expect(activeVersion.result).not.toBeNull();
    const id = oldVersion.result?.templateId ?? '';
    expect(activeVersion.result?.templateId).toBe(id);
    expect(activeVersion.result?.version).not.toBe(oldVersion.result?.version);
    // Set up two versions published before the release-approval requirement existed.
    await seedPreviouslyPublished(id, activeVersion.result?.version ?? '');
    const old = await createTemplateRegistry(env).resolve(id, oldVersion.result?.version);
    for (let i = 0; i < 3; i++) await makePass(f, { orgId: org.id, template: old });
    const legacy = await detailOf(id);
    expect(legacy.versions.find((v) => v.version === old.version)?.passCount).toBe(3);
    expect(legacy.versions.find((v) => v.active)?.passCount).toBe(0);
    expect(legacy.passesOnOlderVersions).toBe(3);
    expect(legacy.passCount).toBe(3);
  });
});

describe('archive and restore', () => {
  it('archives and audits a previously published template and restores it from a legacy head', async () => {
    const t = await importVersion('Season Pass');
    expect(t.result).not.toBeNull();
    const id = t.result?.templateId ?? '';
    const version = t.result?.version ?? '';
    await seedPreviouslyPublished(id, version);
    const existing = await createTemplateRegistry(env).resolve(id);
    await makePass(f, { orgId: org.id, template: existing });
    expect((await post(`/${id}/archive`, {}, outsider)).status).toBe(404);
    expect((await detailOf(id)).status).toBe('active');

    const archive = await post(`/${id}/archive`);
    expect(archive.status).toBe(200);
    const archived = TemplateDetailSchema.parse(await archive.json());
    expect(archived).toMatchObject({ status: 'archived', activeVersion: version, passCount: 1 });
    expect((await createTemplateRegistry(env).resolve(id)).version).toBe(version);
    expect(
      await first(
        env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'template.archive' AND target_id = ?",
        [id],
      ),
    ).not.toBeNull();

    // A legacy release is not an approved head: nothing to roll back to, so Restore is the way back.
    expect(await detailOf(id)).toMatchObject({ status: 'archived', restorable: true });
    expect((await post(`/${id}/restore`)).status).toBe(200);
    expect(await detailOf(id)).toMatchObject({ status: 'active', activeVersion: version });
    expect(
      await first(
        env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'template.restore' AND target_id = ?",
        [id],
      ),
    ).not.toBeNull();
    expect((await post('/baked:starter-generic/archive')).status).toBe(403);
  });

  it('archives an unreleased draft and restores it without a release', async () => {
    const t = await importVersion('Unreleased Draft');
    expect(t.result).not.toBeNull();
    const id = t.result?.templateId ?? '';
    const version = t.result?.version ?? '';
    const draft = await detailOf(id);
    expect(draft.activeVersion).toBeNull();
    expect(draft.versions.find((v) => v.version === version)?.active).toBe(false);
    const versionDetail = await call(`/${id}/versions/${version}`);
    expect(versionDetail.status).toBe(200);
    expect(TemplateVersionDetailSchema.parse(await versionDetail.json())).toMatchObject({
      version,
      active: false,
      manifest: { name: 'Unreleased Draft' },
    });
    const author = await templateAuthor(env, clock, org.id);
    const authorHeaders = (await makeSession(f, { userId: author.userId })).headers;
    expect((await call(`/${id}`, {}, authorHeaders)).status).toBe(200);
    expect((await post(`/${id}/archive`, {}, authorHeaders)).status).toBe(403);
    expect((await detailOf(id)).status).toBe('active');

    expect((await post(`/${id}/activate`, { version })).status).toBe(404);
    expect((await detailOf(id)).activeVersion).toBeNull();
    // Restoring a template that is not archived changes nothing.
    expect((await post(`/${id}/restore`)).status).toBe(200);

    const archive = await post(`/${id}/archive`);
    expect(archive.status).toBe(200);
    expect(TemplateDetailSchema.parse(await archive.json())).toMatchObject({
      status: 'archived',
      activeVersion: null,
    });
    expect(await detailOf(id)).toMatchObject({ status: 'archived', restorable: true });
    expect((await post(`/${id}/restore`, {}, authorHeaders)).status).toBe(403);
    const restored = await post(`/${id}/restore`);
    expect(restored.status).toBe(200);
    expect(TemplateDetailSchema.parse(await restored.json())).toMatchObject({
      status: 'active',
      activeVersion: null,
      restorable: false,
    });
    expect(
      await first(
        env.DB,
        "SELECT 1 FROM audit_log WHERE action = 'template.restore' AND target_id = ?",
        [id],
      ),
    ).not.toBeNull();
  });
});

describe('search, uploads and packages', () => {
  it('searches names and slugs', async () => {
    await importVersion('Harbor Crew Badge');
    const items = async (q: string) =>
      TemplateListSchema.parse(
        await (await call(`?orgId=${org.id}&q=${encodeURIComponent(q)}`)).json(),
      ).items;
    expect((await items('crew')).map((t) => t.name)).toEqual(['Harbor Crew Badge']);
    expect((await items('harbor-crew')).map((t) => t.name)).toEqual(['Harbor Crew Badge']);
    expect(await items('zzz-nothing')).toEqual([]);
  });

  it('lists the newest imports', async () => {
    const res = await call(`/uploads?orgId=${org.id}&limit=2`);
    expect(res.status).toBe(200);
    const list = UploadListSchema.parse(await res.json());
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.createdAt).toBeGreaterThanOrEqual(list.items[1]?.createdAt ?? 0);
  });

  it('packages an unpublished draft for inspection without making it active', async () => {
    const t = await importVersion('Draft Package');
    expect(t.result).not.toBeNull();
    const id = t.result?.templateId ?? '';
    const draftPackage = await call(`/${id}/package`);
    expect(draftPackage.status).toBe(200);
    const draftFiles = unzipSync(new Uint8Array(await draftPackage.arrayBuffer()));
    expect(Object.keys(draftFiles)).toEqual(
      expect.arrayContaining(['pass.json', 'wallet.template.json', 'icon.png']),
    );
    expect((await detailOf(id)).activeVersion).toBeNull();
    await expect(createTemplateRegistry(env).resolve(id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
  });

  it('packages the previously published version instead of a newer candidate', async () => {
    const t = await importVersion('Packaged Card');
    expect(t.result).not.toBeNull();
    const id = t.result?.templateId ?? '';

    await seedPreviouslyPublished(id, t.result?.version ?? '');
    const next = await importVersion('Packaged Card', { 'logo.png': makePng(100, 40) });
    expect(next.result).not.toBeNull();
    expect(next.result?.templateId).toBe(id);
    expect(next.result?.version).not.toBe(t.result?.version);
    const res = await call(`/${id}/package`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['pass.json', 'wallet.template.json', 'icon.png']),
    );
    expect(files['logo.png']).toBeUndefined();
  });

  it('downloads a built-in template as an uploadable zip', async () => {
    const res = await call('/baked:starter-generic/package');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('starter-generic.zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['pass.json', 'wallet.template.json']),
    );
    const m = JSON.parse(new TextDecoder().decode(files['wallet.template.json'])) as object;
    expect(m).not.toHaveProperty('org');
  });
});
