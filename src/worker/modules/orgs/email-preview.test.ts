/// <reference types="vite/client" />

import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { updateSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { crc32, sha1Hex } from '../templates/package/hash.ts';
import { r2Key } from '../templates/registry.ts';
import { generatedSource, syncBakedTemplates } from '../templates/sync.ts';
import { fakeAssets } from '../templates/testing.ts';
import { PREVIEW_STARTER_ID, previewTemplate } from './preview-art.ts';

const clock = new ManualClock();
const app = createApp({
  stores: (env) => ({ ...denyAllStores, sessions: createSessionStore(env, clock) }),
  clock,
});
let appEnv: AppEnv;
let f: Fixtures;
let orgAdmin: SessionFixture;
const ORIGIN = 'http://localhost';
const get = (path: string, headers: Record<string, string> = orgAdmin.headers) =>
  app.request(`${ORIGIN}${path}`, { headers }, appEnv);
const preview = async (orgId: string, query = '', headers = orgAdmin.headers) => {
  const response = await get(`/api/v1/orgs/${orgId}/email-preview${query}`, headers);
  expect(response.status).toBe(200);
  return response.text();
};
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const imgSrc = (html: string, name: string) =>
  new RegExp(`<img src="([^"]*/${name.replace('.', '\\.')}[^"]*)"`).exec(html)?.[1];

beforeAll(async () => {
  const assets = fakeAssets();
  const bakedFiles = import.meta.glob<string>('../../../../templates/**/*.{png,strings}', {
    eager: true,
    query: '?url&inline',
    import: 'default',
  });
  for (const template of generatedSource.templates) {
    const entries = [
      ...template.assets.map((asset) => ({ name: asset.name, path: asset.source.path })),
      ...template.extras,
    ];
    for (const entry of entries) {
      const data = bakedFiles[`../../../../templates/${template.slug}/${entry.name}`];
      if (!data?.startsWith('data:') || !data.includes(';base64,'))
        throw new Error(`Missing baked fixture: ${template.slug}/${entry.name}`);
      assets.files.set(
        entry.path,
        Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), (c) => c.charCodeAt(0)),
      );
    }
  }
  appEnv = await makeEnv({ ASSETS: assets });
  await syncBakedTemplates(createServiceContext(appEnv, { clock }));
  f = fixtures(appEnv, clock);
  const user = await makeUser(f);
  orgAdmin = await makeSession(f, { userId: user.id });
}, 60_000);

async function join(
  orgId: string,
  member = orgAdmin,
  role: 'org_admin' | 'template_author' = 'org_admin',
) {
  const invitationId = f.ids.id();
  const roles = JSON.stringify([role]);
  const now = clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, roles, f.ids.token(), now, now + 3600_000, now, member.userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [f.ids.id(), orgId, member.userId, invitationId, roles, now],
  );
}

describe('email preview art', () => {
  it("shows and serves the starter's icon and logo to a template-reading member", async () => {
    const org = await makeOrg(fixtures(appEnv), { name: 'Bare Climbing' });
    const user = await makeUser(f);
    const author = await makeSession(f, { userId: user.id });
    await join(org.id, author, 'template_author');
    const html = await preview(org.id, '', author.headers);
    const starter = `/api/v1/templates/${encodeURIComponent(PREVIEW_STARTER_ID)}/versions/`;
    for (const name of ['icon@3x.png', 'logo@3x.png']) {
      const asset = new URL(imgSrc(html, name) ?? '');
      expect(asset.origin).toBe(ORIGIN);
      expect(asset.pathname).toMatch(
        new RegExp(`^${starter}[^/]+/assets/${name.replace('.', '\\.')}$`),
      );
      expect(asset.search).toBe(`?orgId=${encodeURIComponent(org.id)}`);
      const assetPath = `${asset.pathname}${asset.search}`;
      expect((await get(assetPath, {})).status).toBe(401);
      const image = await get(assetPath, author.headers);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
    }
    // The starter sets logoText: the org's name stands beside its symbol logo.
    expect(html).toMatch(/font-weight:600;color:[^"]*">Bare Climbing<\/td>/);
    // No holder's capability URL: only the sample's.
    expect(html.match(/\/p\/[^"/]+/g)?.every((p) => p.startsWith('/p/sample'))).toBe(true);
    const asset = new URL(imgSrc(html, 'icon@3x.png') ?? '');
    const outsider = await makeSession(f, { userId: (await makeUser(f)).id });
    expect((await get(`${asset.pathname}${asset.search}`, outsider.headers)).status).toBe(404);
  });

  it("uses the org's upload for its slot and the template's for the other", async () => {
    const org = await makeOrg(fixtures(appEnv));
    await join(org.id);
    const upload = await app.request(
      `${ORIGIN}/api/v1/orgs/${org.id}/branding/icon`,
      {
        method: 'PUT',
        headers: { ...orgAdmin.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ x3: b64(makePng(114, 114)) }),
      },
      appEnv,
    );
    expect(upload.status).toBe(200);
    const html = await preview(org.id);
    const icon = imgSrc(html, 'icon/3x') ?? '';
    expect(icon).toMatch(
      new RegExp(`^${ORIGIN}/api/v1/orgs/${org.id}/branding/icon/3x\\?v=[0-9a-f]{64}$`),
    );
    const iconUrl = new URL(icon);
    expect((await get(`${iconUrl.pathname}${iconUrl.search}`)).headers.get('content-type')).toBe(
      'image/png',
    );
    const logo = new URL(imgSrc(html, 'logo@3x.png') ?? '');
    expect(logo.pathname).toContain('/api/v1/templates/');
    expect(logo.searchParams.get('orgId')).toBe(org.id);
    expect((await get(`${logo.pathname}${logo.search}`)).status).toBe(200);
  });

  it("does not let an orgId filter grant access to another org's preview asset", async () => {
    const owner = await makeOrg(f);
    const other = await makeOrg(f);
    await join(owner.id);
    const outsider = await makeSession(f, { userId: (await makeUser(f)).id });
    await join(other.id, outsider);
    const template = makeTemplate({ id: f.ids.id(), orgId: owner.id }).resolved;
    const bytes = makePng(114, 114);
    const key = `test/preview/${template.id}/icon@3x.png`;
    await appEnv.BUCKET.put(key, bytes);
    await persistTemplate(f, template, {
      assets: [
        {
          name: 'icon@3x.png',
          slot: 'icon',
          scale: 3,
          size: bytes.length,
          sha1: await sha1Hex(bytes),
          crc32: crc32(bytes),
          width: 114,
          height: 114,
          source: { kind: 'r2', key },
        },
      ],
    });
    // Reusing the helper must not replace the stored version or discard its asset.
    await persistTemplate(f, template);
    const html = await preview(owner.id);
    const asset = new URL(imgSrc(html, 'icon@3x.png') ?? '');
    expect(asset.searchParams.get('orgId')).toBe(owner.id);
    const own = await get(`${asset.pathname}${asset.search}`);
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(bytes);
    expect((await get(`${asset.pathname}${asset.search}`, outsider.headers)).status).toBe(404);
    expect(
      (await get(`${asset.pathname}?orgId=${encodeURIComponent(other.id)}`, outsider.headers))
        .status,
    ).toBe(404);
    expect((await get(asset.pathname, outsider.headers)).status).toBe(404);
  });

  it('keeps fixture versions immutable across reuse and retirement', async () => {
    const fixture = makeTemplate({ id: f.ids.id() });
    const template = fixture.resolved;
    const statements: string[] = [];
    const db = new Proxy(appEnv.DB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await persistTemplate(f, template, {
      registry: fixture.registry,
      buildKey: 'fixture-build',
      db,
    });
    expect(
      statements.some((sql) => sql.includes('SELECT EXISTS(SELECT 1 FROM template_versions')),
    ).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO template_versions'))).toBe(true);
    const stored = await first<{ assets: string }>(
      appEnv.DB,
      'SELECT assets FROM template_versions WHERE template_id = ? AND version = ?',
      [template.id, template.version],
    );
    const assets = JSON.parse(stored?.assets ?? '[]') as {
      source: { kind: string; key?: string };
    }[];
    expect(assets).toHaveLength(1);
    expect(assets[0]?.source.kind).toBe('r2');
    const object = await appEnv.BUCKET.get(assets[0]?.source.key ?? '');
    if (!object) throw new Error('Missing materialized fixture asset.');
    const original = await fixture.registry.openAsset(template, 'icon.png');
    const originalBytes = new Uint8Array(await new Response(original).arrayBuffer());
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(originalBytes);

    const { name: templateName, ...manifest } = template.manifest;
    const { description, ...passJson } = template.passJson;
    const reordered = {
      ...template,
      manifest: { ...manifest, name: templateName },
      passJson: { ...passJson, description },
    };
    await persistTemplate(f, reordered);
    statements.length = 0;
    await persistTemplate(f, template, {
      registry: fixture.registry,
      buildKey: 'fixture-build',
      db,
    });
    expect(
      statements.some((sql) => sql.includes('SELECT manifest, pass_json, assets, build_key')),
    ).toBe(true);
    const conflict = { code: 'TEMPLATE_VERSION_CONFLICT' };
    await expect(
      persistTemplate(f, {
        ...template,
        manifest: { ...template.manifest, name: 'Different fixture' },
      }),
    ).rejects.toMatchObject(conflict);
    await expect(
      persistTemplate(f, {
        ...template,
        passJson: { ...template.passJson, description: 'Different pass' },
      }),
    ).rejects.toMatchObject(conflict);
    await expect(persistTemplate(f, template, { assets: [] })).rejects.toMatchObject(conflict);
    await expect(persistTemplate(f, template, { buildKey: null })).rejects.toMatchObject(conflict);
    await expect(persistTemplate(f, template, { buildKey: 'other-build' })).rejects.toMatchObject(
      conflict,
    );

    const changedAsset = fixture.registry.add({
      id: template.id,
      orgId: template.orgId,
      version: template.version,
      manifest: template.manifest,
      passJson: template.passJson,
      assets: { 'icon.png': new Uint8Array([1]) },
    });
    await expect(
      persistTemplate(f, changedAsset, { registry: fixture.registry }),
    ).rejects.toMatchObject(conflict);
    const unchanged = await appEnv.BUCKET.get(assets[0]?.source.key ?? '');
    if (!unchanged) throw new Error('Missing original fixture asset.');
    expect(new Uint8Array(await unchanged.arrayBuffer())).toEqual(originalBytes);

    await run(appEnv.DB, 'DELETE FROM template_versions WHERE template_id = ? AND version = ?', [
      template.id,
      template.version,
    ]);
    await expect(persistTemplate(f, template)).rejects.toMatchObject(conflict);
    const retired = fixture.registry.add({
      id: template.id,
      orgId: template.orgId,
      version: template.version,
      manifest: template.manifest,
      passJson: template.passJson,
      assets: { 'new-icon.png': new Uint8Array([2]) },
    });
    await expect(
      persistTemplate(f, retired, { registry: fixture.registry, db }),
    ).rejects.toMatchObject(conflict);
    expect(
      await appEnv.BUCKET.get(r2Key(template.orgId, template.id, template.version, 'new-icon.png')),
    ).toBeNull();
    expect(
      await first(
        appEnv.DB,
        'SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?',
        [template.id, template.version],
      ),
    ).toBeNull();
  });

  it('materializes initial assets when a pass fixture supplies its registry', async () => {
    const org = await makeOrg(f);
    const fixture = makeTemplate({ id: f.ids.id(), orgId: org.id });
    await makePass(f, { orgId: org.id, template: fixture.resolved, registry: fixture.registry });
    const stored = await first<{ assets: string; build_key: string | null }>(
      appEnv.DB,
      'SELECT assets, build_key FROM template_versions WHERE template_id = ? AND version = ?',
      [fixture.resolved.id, fixture.resolved.version],
    );
    expect(JSON.parse(stored?.assets ?? '[]')).toMatchObject([{ source: { kind: 'r2' } }]);
    expect(stored?.build_key).toBeNull();
    await persistTemplate(f, fixture.resolved, { buildKey: null });
    await expect(
      persistTemplate(f, fixture.resolved, { buildKey: 'other-build' }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
  });

  it('does not overwrite an existing asset during fixture materialization', async () => {
    const fixture = makeTemplate({ id: f.ids.id() });
    const template = fixture.resolved;
    const key = r2Key(template.orgId, template.id, template.version, 'icon.png');
    const prior = new Uint8Array([3]);
    await appEnv.BUCKET.put(key, prior);
    await expect(
      persistTemplate(f, template, { registry: fixture.registry }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_ASSET_CONFLICT' });
    const object = await appEnv.BUCKET.get(key);
    if (!object) throw new Error('Missing original fixture asset.');
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(prior);
  });

  it("picks the template most of the org's live passes use, else its first own one", async () => {
    const f = fixtures(appEnv);
    const ctx = createServiceContext(appEnv);
    const org = await makeOrg(f);
    expect((await previewTemplate(ctx, org.id)).id).toBe(PREVIEW_STARTER_ID);
    const first = makeTemplate({ id: `first-${org.id}`, orgId: org.id }).resolved;
    await persistTemplate(f, first);
    f.clock.advance(1000);
    await persistTemplate(f, makeTemplate({ id: `later-${org.id}`, orgId: org.id }).resolved);
    expect((await previewTemplate(ctx, org.id)).id).toBe(first.id);
    // A platform template counts once the org's passes use it; deleted passes do not.
    const shared = makeTemplate({ id: `shared-${org.id}`, orgId: null }).resolved;
    await makePass(f, { orgId: org.id, template: shared });
    await makePass(f, { orgId: org.id, template: shared });
    await makePass(f, { orgId: org.id, template: first });
    expect((await previewTemplate(ctx, org.id)).id).toBe(shared.id);
    // Other orgs' passes do not count.
    const other = await makeOrg(f);
    const elsewhere = makeTemplate({ id: `elsewhere-${org.id}`, orgId: null }).resolved;
    for (let i = 0; i < 3; i++) await makePass(f, { orgId: other.id, template: elsewhere });
    expect((await previewTemplate(ctx, org.id)).id).toBe(shared.id);
    await run(appEnv.DB, 'UPDATE passes SET deleted_at = 1 WHERE template_id = ?', [shared.id]);
    expect((await previewTemplate(ctx, org.id)).id).toBe(first.id);
  });
});

describe('email preview drafts', () => {
  it('follows unsaved support contacts and the buddy; empty clears one, as Save would', async () => {
    const org = await makeOrg(fixtures(appEnv));
    await join(org.id);
    const ctx = createServiceContext(appEnv, { clock });
    await updateSettings(
      ctx,
      { type: 'user', id: orgAdmin.userId },
      {
        scope: `org:${org.id}`,
        values: { 'support.email': 'saved@gym.test', 'support.url': 'https://gym.test/saved' },
      },
    );
    const saved = await preview(org.id);
    expect(saved).toContain('saved@gym.test');
    expect(saved).toContain('https://gym.test/saved');
    expect(saved).not.toContain('/email/buddy-');
    const draft = await preview(
      org.id,
      `?buddy=1&supportEmail=${encodeURIComponent('draft@gym.test')}&supportUrl=`,
    );
    expect(draft).toContain('mailto:draft@gym.test');
    expect(draft).not.toContain('saved@gym.test');
    expect(draft).not.toContain('https://gym.test/saved');
    expect(draft).toContain('/email/buddy-m-happy-light-top-2x.png');
  });

  it('refuses values Save would refuse', async () => {
    const org = await makeOrg(fixtures(appEnv));
    await join(org.id);
    for (const query of ['?supportEmail=nope', '?supportUrl=http%3A%2F%2Fgym.test', '?buddy=2'])
      expect((await get(`/api/v1/orgs/${org.id}/email-preview${query}`)).status).toBe(422);
  });
});
