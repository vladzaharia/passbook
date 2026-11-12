/// <reference types="vite/client" />

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
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { behaviors } from './build-check.ts';
import { analyzePackage } from './package/analyze.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { buildKey, crc32, sha1Hex } from './package/hash.ts';
import { slugify } from './persist.ts';
import { createTemplateRegistry, r2Key } from './registry.ts';
import { generatedSource, syncBakedTemplates } from './sync.ts';
import { beforeBatch, fakeAssets, importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const workflows: { id: string; params: unknown }[] = [];
const imports: { id: string; params: unknown }[] = [];
let failImportStart = false;
const failBulkStart = false;

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let org: { id: string; slug: string };
let otherOrg: { id: string; slug: string };
let bakedOrg: { id: string; slug: string };
let admin: Record<string, string>;
let user: Record<string, string>;
let adminId: string;
let templateId: string;
let version: string;

async function addMembership(userId: string, orgId: string, roles: OrgRole[]) {
  const invitationId = f.ids.id();
  const membershipId = f.ids.id();
  const now = clock.now();
  await run(
    env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, JSON.stringify(roles), f.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

async function member(orgId: string, roles: OrgRole[], platformAdmin = false) {
  const person = await makeUser(f);
  const membershipId = await addMembership(person.id, orgId, roles);
  const session = await makeSession(f, {
    userId: person.id,
    roles: platformAdmin ? ['admin', 'user'] : ['user'],
  });
  return {
    userId: person.id,
    membershipId,
    sessionId: await sha256Hex(session.cookieValue),
    headers: session.headers,
  };
}

const call = (path: string, init: RequestInit = {}, headers: Record<string, string> = admin) =>
  app.request(
    `${ORIGIN}/api/v1/templates${path}`,
    { ...init, headers: { ...headers, ...init.headers } },
    env,
  );
const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
const post = (path: string, body: unknown, headers = admin) =>
  call(path, { method: 'POST', ...json(body) }, headers);
const upload = (
  zip: Uint8Array,
  query: string,
  headers: Record<string, string> = admin,
  type = 'application/zip',
) =>
  call(
    `/uploads?${query}`,
    { method: 'POST', body: zip, headers: { 'content-type': type } },
    headers,
  );

const manifest = (name: string) => ({
  schema: 1,
  name,
  inputs: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', 'x-label': 'Name' } },
  },
  sample: { name: 'Alex' },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}' },
});

async function seed(
  orgId: string,
  name: string,
  extra: Record<string, Uint8Array | string | null> = {},
) {
  // Persist a legacy published template directly, independently of the draft-only import workflow.
  const analysis = await analyzePackage(
    basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra }),
    { uploaded: true, fallbackName: name, images: {}, behaviors },
  );
  if (!('version' in analysis) || !analysis.report.ok)
    throw new Error(`Invalid legacy template fixture: ${JSON.stringify(analysis.report)}`);
  const id = f.ids.id();
  const now = clock.now();
  const assets = [];
  for (const asset of analysis.assets) {
    const key = r2Key(orgId, id, analysis.version, asset.name);
    const bytes = analysis.files.get(asset.name);
    if (!bytes) throw new Error(`Missing legacy asset ${asset.name}`);
    await env.BUCKET.put(key, bytes);
    assets.push({ ...asset, source: { kind: 'r2' as const, key } });
  }
  await run(
    env.DB,
    `INSERT INTO templates
      (id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'uploaded', ?, 'active', ?, ?, ?, ?)`,
    [
      id,
      orgId,
      slugify(name),
      name,
      analysis.manifest.description ?? null,
      analysis.version,
      JSON.stringify(analysis.styles),
      adminId,
      now,
      now,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO template_versions
      (template_id, version, build_key, manifest, pass_json, assets, report, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      analysis.version,
      await buildKey(analysis),
      JSON.stringify(analysis.manifest),
      JSON.stringify(analysis.passJson),
      JSON.stringify(assets),
      JSON.stringify(analysis.report),
      adminId,
      now,
    ],
  );
  return { id, version: analysis.version };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  // Workerd has no filesystem; Vite embeds the source bytes matching generated metadata.
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
  const assets = fakeAssets();
  for (const t of generatedSource.templates) {
    for (const asset of t.assets) {
      const bytes = bytesFor(t.slug, asset.name);
      if (
        bytes.length !== asset.size ||
        (await sha1Hex(bytes)) !== asset.sha1 ||
        crc32(bytes) !== asset.crc32
      )
        throw new Error(`Baked fixture does not match generated metadata: ${t.slug}/${asset.name}`);
      assets.files.set(asset.source.path, bytes);
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
        if (failBulkStart) throw new Error('workflow down');
        workflows.push(o);
        return { id: o.id };
      },
    } as unknown as Workflow,
    TEMPLATE_IMPORT: {
      create: async (o: { id: string; params: unknown }) => {
        if (failImportStart) throw new Error('workflow down');
        imports.push(o);
        return { id: o.id };
      },
    } as unknown as Workflow,
  });
  f = fixtures(env, clock);
  app = createApp({ stores: { ...auth.stores, sessions: createSessionStore(env, clock) }, clock });
  org = await makeOrg(f);
  otherOrg = await makeOrg(f);
  bakedOrg = await makeOrg(f, { slug: 'henrys', name: 'Henry’s Gymnasium' });
  adminId = (await makeUser(f)).id;
  await addMembership(adminId, org.id, ['org_admin']);
  await addMembership(adminId, otherOrg.id, ['org_admin']);
  await addMembership(adminId, bakedOrg.id, ['org_admin']);
  admin = (await makeSession(f, { userId: adminId, roles: ['admin', 'user'] })).headers;
  user = (await makeSession(f, { userId: (await makeUser(f)).id })).headers;
  ({ id: templateId, version } = await seed(org.id, 'Route Card'));
  await syncBakedTemplates(createServiceContext(env, { clock }));
}, 30_000);

describe('auth', () => {
  it('requires a session or API key', async () => {
    expect((await call('', {}, {})).status).toBe(401);
    expect((await call(`/${templateId}`, {}, {})).status).toBe(401);
  });

  it('requires templates:read for tenant lists and preserves API key scope checks', async () => {
    expect((await call(`?orgId=${org.id}`, {}, admin)).status).toBe(200);
    expect((await call('', {}, auth.apiKey({ scopes: ['templates:read'] }))).status).toBe(200);
    expect((await call(`?orgId=${org.id}`, {}, user)).status).toBe(403);
    const noScope = await call('', {}, auth.apiKey({ scopes: ['passes:read'] }));
    expect(noScope.status).toBe(403);
    expect(await noScope.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it('never grants writes to API keys or to a user without membership', async () => {
    const key = auth.apiKey({ scopes: ['templates:read', 'passes:write'] });
    const attempts: [string, string, RequestInit, number][] = [
      ['POST', `/uploads?orgId=${org.id}`, { body: zipOf(basicPackage()) }, 403],
      ['DELETE', `/${templateId}`, {}, 404],
      ['POST', `/${templateId}/clone`, json({ orgId: org.id }), 404],
      ['POST', `/${templateId}/activate`, json({ version }), 404],
      ['POST', `/${templateId}/archive`, json({}), 404],
      ['POST', `/${templateId}/restore`, json({}), 404],
      ['PUT', `/${templateId}/manifest`, json({ manifest: manifest('x') }), 404],
      ['POST', `/${templateId}/preview`, json({}), 404],
    ];
    for (const [method, path, init, userStatus] of attempts) {
      expect((await call(path, { method, ...init }, key)).status, `${method} ${path}`).toBe(401);
      expect((await call(path, { method, ...init }, user)).status, `${method} ${path}`).toBe(
        userStatus,
      );
    }
    expect(
      await first(env.DB, 'SELECT id FROM templates WHERE id = ?', [templateId]),
    ).not.toBeNull();
  });

  it('enforces CSRF on admin writes', async () => {
    const { 'x-csrf-token': _drop, ...noCsrf } = admin;
    const res = await call(`/${templateId}`, { method: 'DELETE' }, noCsrf);
    expect(res.status).toBe(403);
    expect(
      await first(env.DB, 'SELECT id FROM templates WHERE id = ?', [templateId]),
    ).not.toBeNull();
  });
});

describe('tenant scoping', () => {
  it('limits org-scoped keys to their org plus platform templates', async () => {
    const mine = auth.apiKey({ orgId: org.id, scopes: ['templates:read'] });
    const other = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    const list = (await (await call('', {}, other)).json()) as {
      items: { id: string; orgId: string | null }[];
    };
    expect(list.items.some((t) => t.id === templateId)).toBe(false);
    expect(list.items.every((t) => t.orgId === null || t.orgId === otherOrg.id)).toBe(true);
    expect(list.items.some((t) => t.id.startsWith('baked:'))).toBe(true);
    expect((await call(`/${templateId}`, {}, mine)).status).toBe(200);
    expect((await call(`/${templateId}/versions/${version}`, {}, mine)).status).toBe(200);
    expect(
      (await call(`/${templateId}/versions/${version}/assets/icon.png`, {}, mine)).status,
    ).toBe(200);
    expect((await call(`/${templateId}/package`, {}, mine)).status).toBe(200);
    const keyPreviews = await call(`/previews?ids=${templateId}`, {}, mine);
    expect(keyPreviews.status).toBe(200);
    const keyPreviewBody = (await keyPreviews.json()) as { items: { id: string }[] };
    expect(keyPreviewBody.items.map((item) => item.id)).toContain(templateId);
    expect((await call(`/${templateId}`, {}, other)).status).toBe(404);
    expect((await call(`/${templateId}/versions/${version}`, {}, other)).status).toBe(404);
    expect(
      (await call(`/${templateId}/versions/${version}/assets/icon.png`, {}, other)).status,
    ).toBe(404);
    expect((await call(`/${templateId}/package`, {}, other)).status).toBe(404);
    expect((await call(`?orgId=${org.id}`, {}, other)).status).toBe(403);
    expect((await call('/baked:starter-generic', {}, other)).status).toBe(200);
  });

  it('platform keys may filter by any org', async () => {
    const platformKey = auth.apiKey({ scopes: ['templates:read'] });
    const res = await call(`?orgId=${org.id}`, {}, platformKey);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.some((t) => t.id === templateId)).toBe(true);
  });

  it('hides upload status from other orgs', async () => {
    const r = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Status Scope',
    });
    const mine = auth.apiKey({ orgId: org.id, scopes: ['templates:read'] });
    const noScope = auth.apiKey({ orgId: org.id, scopes: ['passes:read'] });
    const other = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    expect((await call(`/uploads/${r.p.uploadId}`, {}, mine)).status).toBe(200);
    expect((await call(`/uploads/${r.p.uploadId}`, {}, noScope)).status).toBe(403);
    expect((await call(`/uploads/${r.p.uploadId}`, {}, other)).status).toBe(404);
    expect((await call(`/uploads/${r.p.uploadId}`)).status).toBe(200);
  });

  it('binds upload status to the selected org even for members of both orgs', async () => {
    const imported = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Selected Status Scope',
    });
    const reader = await member(org.id, ['read_only']);
    await addMembership(reader.userId, otherOrg.id, ['read_only']);
    const path = `/uploads/${imported.p.uploadId}`;
    const selected = await call(`${path}?orgId=${org.id}`, {}, reader.headers);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      uploadId: imported.p.uploadId,
      status: 'complete',
    });
    const mismatch = await call(`${path}?orgId=${otherOrg.id}`, {}, reader.headers);
    expect(mismatch.status).toBe(404);
    expect(await mismatch.json()).toMatchObject({ code: 'UPLOAD_NOT_FOUND' });
    expect((await call(`${path}?orgId=${org.id}`, {}, admin)).status).toBe(200);
    expect((await call(`${path}?orgId=${otherOrg.id}`, {}, admin)).status).toBe(404);

    const keyA = auth.apiKey({ orgId: org.id, scopes: ['templates:read'] });
    const keyB = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    const platformKey = auth.apiKey({ scopes: ['templates:read'] });
    expect((await call(`${path}?orgId=${org.id}`, {}, keyA)).status).toBe(200);
    expect((await call(`${path}?orgId=${otherOrg.id}`, {}, keyA)).status).toBe(403);
    expect((await call(`${path}?orgId=${org.id}`, {}, keyB)).status).toBe(403);
    expect((await call(`${path}?orgId=${otherOrg.id}`, {}, keyB)).status).toBe(404);
    expect((await call(`${path}?orgId=${org.id}`, {}, platformKey)).status).toBe(200);
    expect((await call(`${path}?orgId=${otherOrg.id}`, {}, platformKey)).status).toBe(404);
  });

  it('scopes tenant lists, detail, versions, assets, previews, packages, and imports by membership', async () => {
    const reader = await member(org.id, ['read_only']);
    const passOperator = await member(org.id, ['pass_operator']);
    const integrationOnly = await member(org.id, ['integration_admin']);
    const foreign = await member(otherOrg.id, ['read_only']);
    const otherTemplate = await seed(otherOrg.id, 'Other Tenant Card');
    const imported = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Scoped Import',
    });
    const list = await call(`?orgId=${org.id}`, {}, reader.headers);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string; orgId: string | null }[] };
    expect(body.items.map((item) => item.id)).toContain(templateId);
    expect(body.items.every((item) => item.orgId === org.id || item.orgId === null)).toBe(true);
    expect(body.items.map((item) => item.id)).not.toContain(otherTemplate.id);
    expect((await call('', {}, reader.headers)).status).toBe(422);
    expect((await call(`?orgId=${otherOrg.id}`, {}, reader.headers)).status).toBe(403);
    expect((await call(`?orgId=${org.id}`, {}, passOperator.headers)).status).toBe(200);
    expect((await call(`?orgId=${org.id}`, {}, integrationOnly.headers)).status).toBe(200);

    for (const path of [
      `/${templateId}`,
      `/${templateId}/versions/${version}`,
      `/${templateId}/versions/${version}/assets/icon.png`,
      `/${templateId}/package`,
      `/uploads/${imported.p.uploadId}`,
    ]) {
      expect((await call(path, {}, reader.headers)).status, path).toBe(200);
      expect((await call(path, {}, foreign.headers)).status, path).toBe(404);
      expect((await call(path, {}, passOperator.headers)).status, path).toBe(200);
      expect((await call(path, {}, integrationOnly.headers)).status, path).toBe(200);
    }
    expect((await post(`/${templateId}/preview`, {}, reader.headers)).status).toBe(200);
    expect((await post(`/${templateId}/preview`, {}, foreign.headers)).status).toBe(404);
    expect((await post(`/${templateId}/preview`, {}, passOperator.headers)).status).toBe(200);
    expect((await post(`/${templateId}/preview`, {}, integrationOnly.headers)).status).toBe(200);
    const previews = await call(
      `/previews?ids=${templateId},${otherTemplate.id},baked:starter-generic&orgId=${org.id}`,
      {},
      reader.headers,
    );
    expect(previews.status).toBe(200);
    const previewBody = (await previews.json()) as { items: { id: string }[] };
    expect(previewBody.items.map((item) => item.id)).toContain(templateId);
    expect(previewBody.items.map((item) => item.id)).not.toContain(otherTemplate.id);
    expect(previewBody.items.map((item) => item.id)).toContain('baked:starter-generic');
    const uploads = await call(`/uploads?orgId=${org.id}`, {}, reader.headers);
    expect(uploads.status).toBe(200);
    const uploadBody = (await uploads.json()) as { items: { uploadId: string }[] };
    expect(uploadBody.items.map((item) => item.uploadId)).toContain(imported.p.uploadId);
    expect((await call(`/uploads?orgId=${org.id}`, {}, foreign.headers)).status).toBe(403);
    expect((await call('/uploads', {}, reader.headers)).status).toBe(422);
  });

  it('does not treat the platform admin role as a tenant grant', async () => {
    const platform = (
      await makeSession(f, {
        userId: (await makeUser(f)).id,
        roles: ['admin', 'user'],
      })
    ).headers;
    expect((await call(`?orgId=${org.id}`, {}, platform)).status).toBe(403);
    expect((await call(`/${templateId}`, {}, platform)).status).toBe(404);
    expect((await call(`/${templateId}/versions/${version}`, {}, platform)).status).toBe(404);
    expect((await call(`/${templateId}/package`, {}, platform)).status).toBe(404);
    expect((await post(`/${templateId}/activate`, { version }, platform)).status).toBe(404);
    expect((await call('/baked:starter-generic', {}, platform)).status).toBe(200);
    expect((await call(`/baked:starter-generic?orgId=${org.id}`, {}, platform)).status).toBe(404);
  });

  it('counts the selected tenant’s passes on shared templates, and every org’s for a platform admin', async () => {
    const reader = await member(org.id, ['read_only']);
    const foreign = await member(otherOrg.id, ['read_only']);
    const id = 'baked:starter-coupon';
    expect((await call(`/${id}?orgId=${org.id}`, {}, reader.headers)).status).toBe(200);
    const shared = await createTemplateRegistry(env).resolve(id);
    await makePass(f, { orgId: org.id, template: shared });
    await makePass(f, { orgId: otherOrg.id, template: shared });
    await makePass(f, { orgId: otherOrg.id, template: shared });
    for (const [orgId, headers, count] of [
      [org.id, reader.headers, 1],
      [otherOrg.id, foreign.headers, 2],
    ] as const) {
      const list = (await (await call(`?orgId=${orgId}`, {}, headers)).json()) as {
        items: { id: string; passCount: number }[];
      };
      expect(list.items.find((item) => item.id === id)?.passCount).toBe(count);
      const detail = (await (await call(`/${id}?orgId=${orgId}`, {}, headers)).json()) as {
        passCount: number;
        versions: { passCount: number }[];
      };
      expect(detail.passCount).toBe(count);
      expect(detail.versions.find((item) => item.passCount === count)).toBeTruthy();
      const scopedKey = auth.apiKey({ orgId, scopes: ['templates:read'] });
      const keyDetail = (await (await call(`/${id}`, {}, scopedKey)).json()) as {
        passCount: number;
      };
      expect(keyDetail.passCount).toBe(count);
      const versionDetail = (await (
        await call(`/${id}/versions/${shared.version}`, {}, scopedKey)
      ).json()) as { passCount: number };
      expect(versionDetail.passCount).toBe(count);
      const sessionVersion = (await (
        await call(`/${id}/versions/${shared.version}?orgId=${orgId}`, {}, headers)
      ).json()) as { passCount: number };
      expect(sessionVersion.passCount).toBe(count);
    }
    const platformDetail = (await (await call(`/${id}`)).json()) as {
      passCount: number;
      versions: { passCount: number }[];
    };
    // A platform administrator sees the shared template's passes across every org.
    expect(platformDetail.passCount).toBe(3);
    expect(platformDetail.versions.reduce((sum, item) => sum + item.passCount, 0)).toBe(3);
    const platformKey = auth.apiKey({ scopes: ['templates:read'] });
    const keyDetail = (await (await call(`/${id}`, {}, platformKey)).json()) as {
      passCount: number;
    };
    expect(keyDetail.passCount).toBe(3);
  });

  it('requires an authorized selected org for non-admin shared-template reads', async () => {
    const reader = await member(org.id, ['read_only']);
    const passOperator = await member(org.id, ['pass_operator']);
    const integrationOnly = await member(org.id, ['integration_admin']);
    const id = 'baked:starter-generic';
    const shared = await createTemplateRegistry(env).resolve(id);
    const asset = shared.assets[0];
    if (!asset) throw new Error('The shared template fixture has no assets');
    for (const path of [
      `/${id}`,
      `/${id}/versions/${shared.version}`,
      `/${id}/versions/${shared.version}/assets/${encodeURIComponent(asset.name)}`,
      `/${id}/package`,
    ]) {
      expect((await call(path, {}, reader.headers)).status, path).toBe(403);
      expect((await call(`${path}?orgId=${org.id}`, {}, reader.headers)).status, path).toBe(200);
      expect((await call(`${path}?orgId=${otherOrg.id}`, {}, reader.headers)).status, path).toBe(
        404,
      );
      expect((await call(`${path}?orgId=${org.id}`, {}, passOperator.headers)).status, path).toBe(
        200,
      );
      expect(
        (await call(`${path}?orgId=${org.id}`, {}, integrationOnly.headers)).status,
        path,
      ).toBe(200);
    }
    expect((await post(`/${id}/preview`, {}, reader.headers)).status).toBe(403);
    const preview = await post(`/${id}/preview`, { orgId: org.id }, reader.headers);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { assetBaseUrl: string };
    const assetUrl = new URL(previewBody.assetBaseUrl);
    expect(assetUrl.searchParams.get('orgId')).toBe(org.id);
    assetUrl.pathname += `/${encodeURIComponent(asset.name)}`;
    expect((await app.request(assetUrl.toString(), { headers: reader.headers }, env)).status).toBe(
      200,
    );
    expect((await post(`/${id}/preview`, { orgId: otherOrg.id }, reader.headers)).status).toBe(404);
    expect((await call(`/previews?ids=${id}`, {}, reader.headers)).status).toBe(403);
    expect((await call(`/previews?ids=${id}&orgId=${org.id}`, {}, reader.headers)).status).toBe(
      200,
    );
    expect(
      (await call(`/previews?ids=${id}&orgId=${otherOrg.id}`, {}, reader.headers)).status,
    ).toBe(403);
  });
});

describe('read', () => {
  it('lists with origin and status filters and paginates', async () => {
    const baked = (await (await call(`?orgId=${org.id}&origin=baked`)).json()) as {
      items: { origin: string }[];
    };
    expect(baked.items.length).toBeGreaterThan(0);
    expect(baked.items.every((t) => t.origin === 'baked')).toBe(true);
    const uploaded = (await (await call(`?origin=uploaded&orgId=${org.id}`)).json()) as {
      items: { origin: string }[];
    };
    expect(uploaded.items.every((t) => t.origin === 'uploaded')).toBe(true);

    const pageOne = (await (await call(`?orgId=${org.id}&limit=1`)).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = (await (
      await call(`?orgId=${org.id}&limit=1&cursor=${encodeURIComponent(pageOne.nextCursor ?? '')}`)
    ).json()) as { items: { id: string }[] };
    expect(pageTwo.items[0]?.id).not.toBe(pageOne.items[0]?.id);
    expect((await call(`?orgId=${org.id}&cursor=garbage`)).status).toBe(422);
  });

  it('hides archived templates unless asked', async () => {
    const t = await seed(org.id, 'Soon Archived');
    const ids = async (q: string) =>
      (
        (await (await call(`?orgId=${org.id}${q}`)).json()) as { items: { id: string }[] }
      ).items.map((i) => i.id);
    expect(await ids('')).toContain(t.id);
    await f.env.DB.prepare("UPDATE templates SET status = 'archived' WHERE id = ?")
      .bind(t.id)
      .run();
    expect(await ids('')).not.toContain(t.id);
    expect(await ids('&includeArchived=true')).toContain(t.id);
    expect(await ids('&includeArchived=false')).not.toContain(t.id);
    expect(await ids('&status=archived')).toContain(t.id);
  });

  it('returns detail with input schema, sample and versions', async () => {
    const body = (await (await call(`/${templateId}`)).json()) as {
      name: string;
      origin: string;
      activeVersion: string;
      passCount: number;
      inputSchema: { properties: Record<string, unknown> };
      sample: unknown;
      versions: { version: string; active: boolean; report: { ok: boolean }; assets: object[] }[];
    };
    expect(body).toMatchObject({
      name: 'Route Card',
      origin: 'uploaded',
      activeVersion: version,
      passCount: 0,
    });
    expect(body.inputSchema.properties).toHaveProperty('name');
    expect(body.sample).toEqual({ name: 'Alex' });
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({ version, active: true, report: { ok: true } });
    expect(JSON.stringify(body)).not.toContain('"source"');
  });

  it('returns baked detail and 404 for unknown ids', async () => {
    const baked = (await (await call('/baked:henrys-blue')).json()) as {
      origin: string;
      versions: unknown[];
    };
    expect(baked.origin).toBe('baked');
    expect(baked.versions).toHaveLength(1);
    const missing = await call('/01900000-0000-7000-8000-000000000000');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('returns a version with its validation report', async () => {
    const body = (await (await call(`/${templateId}/versions/${version}`)).json()) as {
      report: { ok: boolean; issues: unknown[] };
      manifest: { name: string };
      passJson: object;
    };
    expect(body.report.ok).toBe(true);
    expect(body.manifest.name).toBe('Route Card');
    expect((await call(`/${templateId}/versions/nope`)).status).toBe(404);
  });

  it('serves assets with revalidation, ETag and 304', async () => {
    const res = await call(`/${templateId}/versions/${version}/assets/icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(basicPackage().get('icon.png'));
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const cached = await call(`/${templateId}/versions/${version}/assets/icon.png`, {
      headers: { 'if-none-match': etag },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('cache-control')).toBe('private, no-cache');
    expect((await call(`/${templateId}/versions/${version}/assets/missing.png`)).status).toBe(404);
    expect((await call(`/${templateId}/versions/${version}/assets/pass.json`)).status).toBe(404);
    expect((await call(`/${templateId}/versions/deadbeef/assets/icon.png`)).status).toBe(404);
  });

  it.each(['session', 'membership'] as const)(
    'rechecks a revoked %s before returning a conditional asset response',
    async (revoked) => {
      const reader = await member(org.id, ['read_only']);
      const path = `/${templateId}/versions/${version}/assets/icon.png`;
      const firstResponse = await call(path, {}, reader.headers);
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.headers.get('cache-control')).toBe('private, no-cache');
      const etag = firstResponse.headers.get('etag');
      if (!etag) throw new Error('The asset response has no ETag');
      if (revoked === 'session')
        await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
          clock.now(),
          reader.sessionId,
        ]);
      else
        await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
          clock.now(),
          reader.membershipId,
        ]);
      const conditional = await call(path, { headers: { 'if-none-match': etag } }, reader.headers);
      expect(conditional.status).toBe(revoked === 'session' ? 401 : 404);
    },
  );

  it('serves localized assets by encoded path and never traverses', async () => {
    const t = await seed(org.id, 'Localized', { 'en.lproj/pass.strings': '"a" = "b";' });
    const res = await call(
      `/${t.id}/versions/${t.version}/assets/${encodeURIComponent('en.lproj/pass.strings')}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('"a" = "b";');
    for (const name of ['..%2F..%2Fpass.json', '%2e%2e%2fsecret', 'en.lproj%2F..%2Fpass.json']) {
      const bad = await call(`/${t.id}/versions/${t.version}/assets/${name}`);
      expect([404, 422], name).toContain(bad.status);
    }
  });

  it('serves persisted baked version assets from R2', async () => {
    const baked = generatedSource.templates[0];
    if (!baked) throw new Error('Expected a baked template fixture');
    const asset = baked.assets.find((a) => a.name.endsWith('.png'));
    if (!asset) throw new Error('Expected a baked image fixture');
    const resolved = await createTemplateRegistry(env).resolve(baked.id, baked.version);
    const stored = resolved.assets.find((a) => a.name === asset.name);
    if (stored?.source.kind !== 'r2') throw new Error('Expected a persisted baked asset');
    const object = await env.BUCKET.get(stored.source.key);
    if (!object) throw new Error('Missing persisted baked asset');
    const res = await call(
      `/${encodeURIComponent(baked.id)}/versions/${baked.version}/assets/${asset.name}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${asset.sha1}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(await object.arrayBuffer()),
    );
  });

  it('previews pass.json for the sample, for input, and rejects bad input', async () => {
    const sample = (await (await post(`/${templateId}/preview`, {})).json()) as {
      passJson: { generic: { primaryFields: { value: string }[] }; serialNumber: string };
      warnings: unknown[];
      assetBaseUrl: string;
    };
    expect(sample.passJson.generic.primaryFields[0]?.value).toBe('Alex');
    expect(sample.assetBaseUrl).toBe(
      `${env.PUBLIC_BASE_URL}/api/v1/templates/${templateId}/versions/${version}/assets`,
    );
    const custom = (await (
      await post(`/${templateId}/preview`, { input: { name: 'Sam' } })
    ).json()) as typeof sample;
    expect(custom.passJson.generic.primaryFields[0]?.value).toBe('Sam');
    const bad = await post(`/${templateId}/preview`, { input: {} });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await post(`/${templateId}/preview`, { version: 'nope' })).status).toBe(404);
  });

  it('previews many templates in one request and skips ids it cannot read', async () => {
    const res = await call(`/previews?ids=${templateId},missing-template`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; assetNames: string[] }[] };
    expect(body.items.map((i) => i.id)).toEqual([templateId]);
    expect((await call('/previews?ids=')).status).toBe(422);
  });

  it('previews a shared starter with no org: no empty back field but the message, no template name as the org', async () => {
    const res = await post(`/${encodeURIComponent('baked:starter-coupon')}/preview`, {});
    expect(res.status).toBe(200);
    const { passJson } = (await res.json()) as {
      passJson: {
        organizationName: string;
        coupon: { backFields: { key: string; value: unknown }[] };
      };
    };
    expect(passJson.organizationName).toBe('Organization');
    const back = passJson.coupon.backFields;
    // The message field stays so the first message changes a field instead of adding one.
    expect(back.filter((f) => f.value === '').map((f) => f.key)).toEqual(['message']);
    expect(back.find((f) => f.key === 'pass-service')?.value).toBe(env.PUBLIC_BASE_URL);
  });
});

describe('upload', () => {
  const zip = () => zipOf(basicPackage());

  it('stores the archive, records the run and starts the workflow', async () => {
    const res = await upload(zip(), `orgId=${org.id}&name=Uploaded`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { uploadId: string; workflowInstanceId: string };
    expect(body.workflowInstanceId).toBe(body.uploadId);
    expect((await env.BUCKET.head(`uploads/${body.uploadId}.zip`))?.size).toBe(zip().length);
    expect(imports.at(-1)).toEqual({
      id: body.uploadId,
      params: {
        uploadId: body.uploadId,
        orgId: org.id,
        objectKey: `uploads/${body.uploadId}.zip`,
        createdBy: adminId,
        authority: expect.objectContaining({
          kind: 'session',
          orgId: org.id,
          capability: 'templates:author',
        }),
      },
    });
    expect(JSON.stringify(imports.at(-1))).not.toContain(admin['x-csrf-token']);
    expect(JSON.stringify(imports.at(-1))).not.toContain(admin.cookie);
    const run = await first<{ kind: string; status: string; org_id: string }>(
      env.DB,
      'SELECT kind, status, org_id FROM workflow_runs WHERE instance_id = ?',
      [body.uploadId],
    );
    expect(run).toEqual({ kind: 'template_import', status: 'queued', org_id: org.id });

    const status = (await (await call(`/uploads/${body.uploadId}`)).json()) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({
      uploadId: body.uploadId,
      status: 'queued',
      step: 'queued',
      templateId: null,
      report: null,
      error: null,
    });
  });

  it('accepts multipart uploads', async () => {
    const form = new FormData();
    form.set('file', new File([zip()], 'card.zip', { type: 'application/zip' }));
    const res = await call(`/uploads?orgId=${org.id}`, { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const none = new FormData();
    none.set('note', 'text only');
    expect((await call(`/uploads?orgId=${org.id}`, { method: 'POST', body: none })).status).toBe(
      400,
    );
  });

  it('rejects non-zip bodies, missing orgs and bad queries', async () => {
    const notZip = await upload(new TextEncoder().encode('plain text'), `orgId=${org.id}`);
    expect(notZip.status).toBe(400);
    expect(await notZip.json()).toMatchObject({ code: 'NOT_A_ZIP' });
    const noOrg = await upload(zip(), 'orgId=01900000-0000-7000-8000-000000000000');
    expect(noOrg.status).toBe(403);
    expect((await upload(new Uint8Array(), `orgId=${org.id}`)).status).toBe(400);
  });

  it('applies its own 15 MB body limit', async () => {
    const huge = new Uint8Array(16 * 1024 * 1024);
    huge.set([0x50, 0x4b, 3, 4]);
    const before = imports.length;
    const res = await upload(huge, `orgId=${org.id}`);
    expect(res.status).toBe(413);
    expect(imports.length).toBe(before);
  });

  it('reports a workflow start failure and leaves no stored archive', async () => {
    failImportStart = true;
    try {
      const res = await upload(zip(), `orgId=${org.id}&name=Fails`);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'WORKFLOW_START' });
    } finally {
      failImportStart = false;
    }
    const run = await first<{ status: string; error_code: string }>(
      env.DB,
      "SELECT status, error_code FROM workflow_runs WHERE error_code = 'WORKFLOW_START'",
    );
    expect(run?.status).toBe('errored');
  });

  it('shows the report of a rejected import and the result of a finished one', async () => {
    const bad = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage({ 'icon.png': makePng(1, 1) })),
    });
    const failed = (await (await call(`/uploads/${bad.p.uploadId}`)).json()) as {
      status: string;
      error: string;
      report: { ok: boolean; issues: { code: string }[] };
    };
    expect(failed.status).toBe('errored');
    expect(failed.error).toBe('IMPORT_INVALID');
    expect(failed.report.issues.map((i) => i.code)).toContain('IMAGE_SIZE');

    const good = await importZip(env, clock, { orgId: org.id, zip: zip(), name: 'Finished' });
    const done = (await (await call(`/uploads/${good.p.uploadId}`)).json()) as {
      status: string;
      templateId: string;
      version: string;
      report: { ok: boolean };
    };
    expect(done).toMatchObject({
      status: 'complete',
      templateId: good.result?.templateId,
      version: good.result?.version,
    });
    expect(done.report.ok).toBe(true);
    const detail = await call(`/${done.templateId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      activeVersion: null,
      versions: [expect.objectContaining({ version: done.version, active: false })],
    });
    expect((await call(`/${done.templateId}/versions/${done.version}`)).status).toBe(200);
    expect((await call(`/${done.templateId}/package`)).status).toBe(200);
    expect((await call('/uploads/nope')).status).toBe(404);
  });

  it('audits the upload', async () => {
    const rows = await all<{ action: string; org_id: string; actor_type: string }>(
      env.DB,
      "SELECT action, org_id, actor_type FROM audit_log WHERE action = 'template.upload'",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ org_id: org.id, actor_type: 'user' });
  });
});

describe('template author capability', () => {
  it('permits authoring drafts while denying readers, publishers, and unauthorized destinations', async () => {
    const author = await member(org.id, ['template_author']);
    const publisher = await member(org.id, ['template_publisher']);
    const platformReader = await member(org.id, ['read_only'], true);
    const integrationOnly = await member(org.id, ['integration_admin']);
    const t = await seed(org.id, 'Author Manifest');
    const changed = { ...manifest('Author Manifest'), display: { title: 'Draft title' } };
    for (const headers of [publisher.headers, platformReader.headers, integrationOnly.headers]) {
      expect((await upload(zipOf(basicPackage()), `orgId=${org.id}`, headers)).status).toBe(403);
      expect(
        (
          await post(
            '/baked:starter-generic/clone',
            {
              orgId: org.id,
              name: 'Forbidden Copy',
            },
            headers,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await call(
            `/${t.id}/manifest`,
            {
              method: 'PUT',
              ...json({ manifest: changed }),
            },
            headers,
          )
        ).status,
      ).toBe(403);
    }
    expect((await upload(zipOf(basicPackage()), `orgId=${org.id}`, author.headers)).status).toBe(
      202,
    );
    const edited = await call(
      `/${t.id}/manifest`,
      {
        method: 'PUT',
        ...json({ manifest: changed }),
      },
      author.headers,
    );
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ activeVersion: t.version });
    expect(
      (
        await post(
          '/baked:starter-generic/clone',
          {
            orgId: otherOrg.id,
            name: 'Forbidden Destination',
          },
          author.headers,
        )
      ).status,
    ).toBe(404);
    const cloned = await post(
      '/baked:starter-generic/clone',
      {
        orgId: org.id,
        name: 'Author Draft Copy',
      },
      author.headers,
    );
    expect(cloned.status).toBe(201);
    expect(await cloned.json()).toMatchObject({
      orgId: org.id,
      activeVersion: null,
      versions: [expect.objectContaining({ active: false })],
    });
  });
});
describe('clone', () => {
  it('clones a baked template into an uploaded copy with its own assets', async () => {
    const res = await post('/baked:henrys-blue/clone', { orgId: org.id, name: 'Henry Copy' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      origin: string;
      orgId: string;
      slug: string;
      name: string;
      activeVersion: string | null;
      versions: { version: string }[];
    };
    expect(body).toMatchObject({
      origin: 'uploaded',
      orgId: org.id,
      slug: 'henry-copy',
      name: 'Henry Copy',
      activeVersion: null,
    });
    const v = await createTemplateRegistry(env).resolve(body.id, body.versions[0]?.version);
    expect(v.manifest.name).toBe('Henry Copy');
    expect(v.assets.every((a) => a.source.kind === 'r2')).toBe(true);
    const first1 = v.assets[0];
    expect(first1?.source.kind === 'r2' && (await env.BUCKET.head(first1.source.key))).toBeTruthy();
    expect(
      await first<{ action: string }>(
        env.DB,
        "SELECT action FROM audit_log WHERE action = 'template.clone' AND target_id = ?",
        [body.id],
      ),
    ).not.toBeNull();
  });

  it('refuses a duplicate name, an unauthorized org and an unknown baked source', async () => {
    expect(
      (await post('/baked:henrys-blue/clone', { orgId: org.id, name: 'Henry Copy' })).status,
    ).toBe(409);
    expect(
      (await post('/baked:henrys-blue/clone', { orgId: '01900000-0000-7000-8000-000000000000' }))
        .status,
    ).toBe(403);
    expect((await post('/baked:nope/clone', { orgId: org.id })).status).toBe(404);
  });

  it('clones an uploaded template and names it by default', async () => {
    const res = await post(`/${templateId}/clone`, { orgId: otherOrg.id });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Route Card copy', orgId: otherOrg.id });
  });
});

describe('clone source lineage', () => {
  it('requires source read and destination author grants, including the destination context for shared sources', async () => {
    const sourceReader = await member(org.id, ['read_only']);
    await addMembership(sourceReader.userId, otherOrg.id, ['template_author']);
    const destOnly = await member(otherOrg.id, ['template_author']);
    const sourceIntegrator = await member(org.id, ['integration_admin']);
    await addMembership(sourceIntegrator.userId, otherOrg.id, ['template_author']);
    const noDestAuthor = await member(org.id, ['read_only']);
    await addMembership(noDestAuthor.userId, otherOrg.id, ['read_only']);

    const body = { orgId: otherOrg.id, name: 'Scoped Source Copy' };
    expect((await post(`/${templateId}/clone`, body, destOnly.headers)).status).toBe(404);
    expect((await post(`/${templateId}/clone`, body, noDestAuthor.headers)).status).toBe(403);

    const cloned = await post(`/${templateId}/clone`, body, sourceReader.headers);
    expect(cloned.status).toBe(201);
    const result = (await cloned.json()) as {
      id: string;
      orgId: string;
      activeVersion: string | null;
      versions: { version: string; active: boolean }[];
    };
    expect(result).toMatchObject({ orgId: otherOrg.id, activeVersion: null });
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.active).toBe(false);
    const copied = await createTemplateRegistry(env).resolve(
      result.id,
      result.versions[0]?.version,
    );
    expect(copied.manifest.name).toBe(body.name);
    expect(copied.assets.every((asset) => asset.source.kind === 'r2')).toBe(true);
    const integrationClone = await post(
      `/${templateId}/clone`,
      {
        orgId: otherOrg.id,
        name: 'Integration Source Copy',
      },
      sourceIntegrator.headers,
    );
    expect(integrationClone.status).toBe(201);

    expect(
      (
        await post(
          '/baked:henrys-blue/clone',
          {
            orgId: otherOrg.id,
            name: 'Inaccessible Baked Source',
          },
          destOnly.headers,
        )
      ).status,
    ).toBe(404);
    const shared = await post(
      '/baked:starter-generic/clone',
      {
        orgId: otherOrg.id,
        name: 'Scoped Shared Source Copy',
      },
      destOnly.headers,
    );
    expect(shared.status).toBe(201);
    expect(await shared.json()).toMatchObject({
      orgId: otherOrg.id,
      activeVersion: null,
      versions: [expect.objectContaining({ active: false })],
    });
  });

  it.each(['membership', 'reassignment'] as const)(
    'does not commit a clone after source %s changes at the destination transaction',
    async (change) => {
      const sourceName = `Clone source ${change}`;
      const imported = await importZip(env, clock, {
        orgId: org.id,
        name: sourceName,
        zip: zipOf(
          basicPackage({
            'wallet.template.json': JSON.stringify(manifest(sourceName)),
          }),
        ),
      });
      if (!imported.result) throw new Error('Source draft import failed');
      // Settle the baked sync before taking snapshots or intercepting the clone transaction.
      expect((await call('/baked:starter-generic')).status).toBe(200);
      const sourceId = imported.result.templateId;
      const sourceReader = await member(org.id, ['read_only']);
      await addMembership(sourceReader.userId, otherOrg.id, ['template_author']);
      const cloneName = `Fenced clone ${change}`;
      const cloneSlug = slugify(cloneName);
      const beforeVersions = await first<{ n: number }>(
        env.DB,
        'SELECT COUNT(*) AS n FROM template_versions',
      );
      const beforeClones = await first<{ n: number }>(
        env.DB,
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.clone'",
      );
      expect(
        await first(env.DB, 'SELECT id FROM templates WHERE org_id = ? AND slug = ?', [
          otherOrg.id,
          cloneSlug,
        ]),
      ).toBeNull();
      let prepared = false;
      let intervened = false;
      let movedStatus: number | undefined;
      const db = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare')
            return (sql: string) => {
              if (/INSERT\s+INTO\s+templates\s*\(/i.test(sql)) prepared = true;
              return target.prepare(sql);
            };
          if (prop === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (prepared && !intervened) {
                intervened = true;
                if (change === 'membership') {
                  await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                    clock.now(),
                    sourceReader.membershipId,
                  ]);
                } else {
                  const moved = await call(`/${sourceId}`, {
                    method: 'PATCH',
                    ...json({ orgId: otherOrg.id }),
                  });
                  movedStatus = moved.status;
                }
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const response = await app.request(
        `${ORIGIN}/api/v1/templates/${sourceId}/clone`,
        {
          method: 'POST',
          headers: { ...sourceReader.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ orgId: otherOrg.id, name: cloneName }),
        },
        { ...env, DB: db },
      );
      expect(intervened).toBe(true);
      if (change === 'reassignment') expect(movedStatus).toBe(200);
      expect(response.status).toBe(change === 'membership' ? 404 : 409);
      expect(
        await first(env.DB, 'SELECT id FROM templates WHERE org_id = ? AND slug = ?', [
          otherOrg.id,
          cloneSlug,
        ]),
      ).toBeNull();
      expect(await first(env.DB, 'SELECT COUNT(*) AS n FROM template_versions')).toEqual(
        beforeVersions,
      );
      expect(
        await first(env.DB, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.clone'"),
      ).toEqual(beforeClones);
    },
  );
});

describe('activation route', () => {
  let t: { id: string; version: string };
  let v2: string;
  beforeAll(async () => {
    t = await seed(org.id, 'Activate Me');
    const second = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify(manifest('Activate Me')),
          'logo.png': makePng(100, 40),
        }),
      ),
      name: 'Activate Me',
    });
    v2 = second.result?.version ?? '';
  });

  it('does not exist: a release is the only way to activate a version', async () => {
    const author = await member(org.id, ['template_author']);
    const publisher = await member(org.id, ['template_publisher']);
    const reader = await member(org.id, ['read_only']);
    const integrationOnly = await member(org.id, ['integration_admin']);
    const before = await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id]);
    const versionsBefore = await all(
      env.DB,
      'SELECT * FROM template_versions WHERE template_id = ?',
      [t.id],
    );
    for (const target of [t.version, v2])
      for (const who of [author, reader, integrationOnly, publisher])
        expect((await post(`/${t.id}/activate`, { version: target }, who.headers)).status).toBe(
          404,
        );
    expect(await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id])).toEqual(before);
    expect(
      await all(env.DB, 'SELECT * FROM template_versions WHERE template_id = ?', [t.id]),
    ).toEqual(versionsBefore);
    expect(
      workflows.filter((w) => (w.params as { templateId: string }).templateId === t.id),
    ).toHaveLength(0);
    expect(
      await first(
        env.DB,
        "SELECT id FROM audit_log WHERE action = 'template.activate' AND target_id = ?",
        [t.id],
      ),
    ).toBeNull();
    expect((await post('/baked:henrys-blue/activate', { version: 'x' })).status).toBe(404);
  });

  it('lets publishers archive and restore a template that was never released', async () => {
    const t = await seed(org.id, 'Scoped Archive');
    const author = await member(org.id, ['template_author']);
    const publisher = await member(org.id, ['template_publisher']);
    expect((await post(`/${t.id}/archive`, {}, author.headers)).status).toBe(403);
    expect((await post(`/${t.id}/archive`, {}, publisher.headers)).status).toBe(200);
    expect((await post(`/${t.id}/restore`, {}, author.headers)).status).toBe(403);
    expect((await post(`/${t.id}/restore`, {}, publisher.headers)).status).toBe(200);
    expect(
      await first(env.DB, 'SELECT status, active_version FROM templates WHERE id = ?', [t.id]),
    ).toEqual({
      status: 'active',
      active_version: t.version,
    });
  });
});

describe('archive authority at commit', () => {
  it.each(['session', 'membership'] as const)(
    'does not archive when the %s is revoked immediately before the write',
    async (revoked) => {
      const t = await seed(org.id, `Archive race ${revoked}`);
      expect((await call('/baked:starter-generic')).status).toBe(200);
      const publisher = await member(org.id, ['template_publisher']);
      const before = await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id]);
      const audits = await all(env.DB, 'SELECT * FROM audit_log WHERE target_id = ?', [t.id]);
      let intervened = false;
      const raced = beforeBatch(env, /UPDATE\s+templates\s+SET\s+status\s*=\s*\?/i, async () => {
        intervened = true;
        if (revoked === 'session')
          await run(env.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
            clock.now(),
            publisher.sessionId,
          ]);
        else
          await run(env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
            clock.now(),
            publisher.membershipId,
          ]);
      });
      const response = await app.request(
        `${ORIGIN}/api/v1/templates/${t.id}/archive`,
        { method: 'POST', headers: publisher.headers },
        raced,
      );
      expect(intervened).toBe(true);
      expect([403, 404]).toContain(response.status);
      expect(await first(env.DB, 'SELECT * FROM templates WHERE id = ?', [t.id])).toEqual(before);
      expect(await all(env.DB, 'SELECT * FROM audit_log WHERE target_id = ?', [t.id])).toEqual(
        audits,
      );
    },
  );
});

describe('manifest', () => {
  it('creates a draft version from a valid manifest without changing the active one', async () => {
    const t = await seed(org.id, 'Edit Manifest');
    const next = { ...manifest('Edit Manifest'), display: { title: 'Fixed title' } };
    const res = await call(`/${t.id}/manifest`, { method: 'PUT', ...json({ manifest: next }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activeVersion: string;
      versions: { version: string }[];
    };
    expect(body.activeVersion).toBe(t.version);
    expect(body.versions).toHaveLength(2);
    const candidate = body.versions.find((item) => item.version !== t.version)?.version;
    expect(candidate).toBeTruthy();
    const same = await call(`/${t.id}/manifest`, { method: 'PUT', ...json({ manifest: next }) });
    expect(((await same.json()) as { versions: unknown[] }).versions).toHaveLength(2);
    const resolved = await createTemplateRegistry(env).resolve(t.id, candidate);
    expect(resolved.manifest.display.title).toBe('Fixed title');
    expect(resolved.assets).toHaveLength(2);
  });

  it('rejects invalid manifests with field issues and changes nothing', async () => {
    const t = await seed(org.id, 'Bad Manifest');
    const bad = {
      ...manifest('Bad Manifest'),
      inputs: { type: 'object', properties: { name: { type: 'string', pattern: '(a+)+$' } } },
    };
    const res = await call(`/${t.id}/manifest`, { method: 'PUT', ...json({ manifest: bad }) });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; issues: { code: string }[] };
    expect(problem.code).toBe('MANIFEST_INVALID');
    expect(problem.issues.map((i) => i.code)).toContain('SCHEMA_PATTERN');
    const detail = (await (await call(`/${t.id}`)).json()) as { versions: unknown[] };
    expect(detail.versions).toHaveLength(1);
  });

  it('is blocked for baked templates', async () => {
    const res = await call('/baked:henrys-blue/manifest', {
      method: 'PUT',
      ...json({ manifest: manifest('x') }),
    });
    expect(res.status).toBe(403);
  });
});

describe('delete', () => {
  it('refuses baked templates with 403 TEMPLATE_BAKED', async () => {
    const res = await call('/baked:henrys-blue', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_BAKED' });
    expect(
      await first(env.DB, "SELECT id FROM templates WHERE id = 'baked:henrys-blue'"),
    ).not.toBeNull();
  });

  it('hard deletes an unreferenced uploaded template with its rows and objects', async () => {
    const t = await seed(org.id, 'Hard Delete');
    const prefix = `templates/${org.id}/${t.id}/`;
    expect((await env.BUCKET.list({ prefix })).objects.length).toBeGreaterThan(0);
    const res = await call(`/${t.id}`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ ok: true, outcome: 'deleted' });
    expect(await first(env.DB, 'SELECT id FROM templates WHERE id = ?', [t.id])).toBeNull();
    expect(
      await first(env.DB, 'SELECT 1 FROM template_versions WHERE template_id = ?', [t.id]),
    ).toBeNull();
    expect((await env.BUCKET.list({ prefix })).objects).toEqual([]);
    expect((await call(`/${t.id}`)).status).toBe(404);
    expect((await call(`/${t.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('archives instead when any pass references any version', async () => {
    const t = await seed(org.id, 'Referenced');
    const second = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify(manifest('Referenced')),
          'logo.png': makePng(100, 40),
        }),
      ),
      name: 'Referenced',
    });
    const oldVersion = await createTemplateRegistry(env).resolve(t.id, t.version);
    await makePass(f, { orgId: org.id, template: oldVersion });
    expect(second.result?.version).not.toBe(t.version);

    const res = await call(`/${t.id}`, { method: 'DELETE' });
    expect(await res.json()).toEqual({ ok: true, outcome: 'archived' });
    const row = await first<{ status: string }>(
      env.DB,
      'SELECT status FROM templates WHERE id = ?',
      [t.id],
    );
    expect(row?.status).toBe('archived');
    expect(
      await all(env.DB, 'SELECT version FROM template_versions WHERE template_id = ?', [t.id]),
    ).toHaveLength(2);
    expect(
      (await env.BUCKET.list({ prefix: `templates/${org.id}/${t.id}/` })).objects.length,
    ).toBeGreaterThan(0);
    expect(((await (await call(`/${t.id}`)).json()) as { passCount: number }).passCount).toBe(1);
    const again = await call(`/${t.id}`, { method: 'DELETE' });
    expect(await again.json()).toEqual({ ok: true, outcome: 'archived' });
    const actions = (
      await all<{ action: string }>(env.DB, 'SELECT action FROM audit_log WHERE target_id = ?', [
        t.id,
      ])
    ).map((a) => a.action);
    expect(actions).toEqual(['template.archive', 'template.archive']);
  });

  it('audits hard deletes', async () => {
    const t = await seed(org.id, 'Audit Delete');
    await call(`/${t.id}`, { method: 'DELETE' });
    const row = await first<{ action: string; org_id: string; actor_id: string }>(
      env.DB,
      'SELECT action, org_id, actor_id FROM audit_log WHERE target_id = ?',
      [t.id],
    );
    expect(row).toEqual({ action: 'template.delete', org_id: org.id, actor_id: adminId });
  });
});

describe('org assignment', () => {
  const patch = (id: string, body: unknown, headers = admin) =>
    call(`/${id}`, { method: 'PATCH', ...json(body) }, headers);
  const orgOf = async (id: string) =>
    (
      await first<{ org_id: string | null }>(env.DB, 'SELECT org_id FROM templates WHERE id = ?', [
        id,
      ])
    )?.org_id;

  const assignmentAudits = (id: string) =>
    all(
      env.DB,
      "SELECT * FROM audit_log WHERE action = 'template.assign_org' AND target_id = ? ORDER BY id",
      [id],
    );
  const systemReleases = (id: string) =>
    all<{ org_id: string | null; mode: string; source: string; version: string }>(
      env.DB,
      'SELECT org_id, mode, source, version FROM template_releases WHERE template_id = ? ORDER BY mode',
      [id],
    );

  it('blocks assigning a shared baked template after its system releases', async () => {
    const id = 'baked:starter-generic';
    const baked = generatedSource.templates.find((t) => t.id === id);
    if (!baked) throw new Error('Expected a shared baked template fixture');
    const before = await first(env.DB, 'SELECT org_id, updated_at FROM templates WHERE id = ?', [
      id,
    ]);
    const releases = await systemReleases(id);
    expect(releases).toEqual([
      { org_id: null, mode: 'live', source: 'system', version: baked.version },
      { org_id: null, mode: 'test', source: 'system', version: baked.version },
    ]);
    expect(await assignmentAudits(id)).toEqual([]);
    for (const destination of [org.id, otherOrg.id]) {
      const res = await patch(id, { orgId: destination });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      expect(await orgOf(id)).toBeNull();
    }
    const unchanged = await patch(id, { orgId: null });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ orgId: null, orgName: null });
    expect(
      await first(env.DB, 'SELECT org_id, updated_at FROM templates WHERE id = ?', [id]),
    ).toEqual(before);
    expect(await systemReleases(id)).toEqual(releases);
    expect(await assignmentAudits(id)).toEqual([]);
    const other = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    expect((await call(`/${id}`, {}, other)).status).toBe(200);
  });

  it('blocks moving or unassigning an org-owned baked template after its system releases', async () => {
    const id = 'baked:henrys-blue';
    const baked = generatedSource.templates.find((t) => t.id === id);
    if (!baked) throw new Error('Expected an org-owned baked template fixture');
    const before = await first(env.DB, 'SELECT org_id, updated_at FROM templates WHERE id = ?', [
      id,
    ]);
    expect(await orgOf(id)).toBe(bakedOrg.id);
    const releases = await systemReleases(id);
    expect(releases).toEqual([
      { org_id: bakedOrg.id, mode: 'live', source: 'system', version: baked.version },
      { org_id: bakedOrg.id, mode: 'test', source: 'system', version: baked.version },
    ]);
    expect(await assignmentAudits(id)).toEqual([]);
    const owner = auth.apiKey({ orgId: bakedOrg.id, scopes: ['templates:read'] });
    const other = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    expect((await call(`/${id}`, {}, owner)).status).toBe(200);
    expect((await call(`/${id}`, {}, other)).status).toBe(404);
    expect((await patch(id, { orgId: null }, other)).status).toBe(401);
    const author = await member(bakedOrg.id, ['template_author']);
    await addMembership(author.userId, org.id, ['template_author']);
    expect((await patch(id, { orgId: org.id }, author.headers)).status).toBe(403);
    expect((await patch(id, { orgId: null }, user)).status).toBe(404);
    for (const destination of [org.id, otherOrg.id, null]) {
      const res = await patch(id, { orgId: destination });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      expect(await orgOf(id)).toBe(bakedOrg.id);
    }
    const unchanged = await patch(id, { orgId: bakedOrg.id });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({
      orgId: bakedOrg.id,
      orgName: 'Henry’s Gymnasium',
    });
    expect(
      await first(env.DB, 'SELECT org_id, updated_at FROM templates WHERE id = ?', [id]),
    ).toEqual(before);
    expect(await systemReleases(id)).toEqual(releases);
    expect(await assignmentAudits(id)).toEqual([]);
    expect((await call(`/${id}`, {}, other)).status).toBe(404);
  });

  it('hides assignments from non-members and keeps API keys read-only', async () => {
    expect((await patch(templateId, { orgId: null }, user)).status).toBe(404);
    const key = auth.apiKey({ scopes: ['templates:read', 'passes:write'] });
    expect((await patch(templateId, { orgId: null }, key)).status).toBe(401);
    expect((await patch(templateId, { orgId: null }, {})).status).toBe(401);
    expect((await call(`/${templateId}`, {}, key)).status).toBe(200);
  });

  it('validates the body and the org', async () => {
    expect((await patch(templateId, {})).status).toBe(422);
    expect(
      (await patch(templateId, { orgId: '01900000-0000-7000-8000-000000000000' })).status,
    ).toBe(404);
    expect((await patch('baked:nope', { orgId: null })).status).toBe(404);
  });

  it('prevents moving a previously published template without an approved release', async () => {
    const t = await seed(org.id, 'Shared Card');
    const template = await createTemplateRegistry(env).resolve(t.id, t.version);
    await makePass(f, { orgId: org.id, template });
    for (const destination of [otherOrg.id, null]) {
      const res = await patch(t.id, { orgId: destination });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      expect(await orgOf(t.id)).toBe(org.id);
    }
    expect((await patch(t.id, { orgId: org.id })).status).toBe(200);
  });

  it('also blocks moving an unreferenced published template', async () => {
    const t = await seed(org.id, 'Unreferenced Published');
    for (const destination of [otherOrg.id, null]) {
      const response = await patch(t.id, { orgId: destination });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_REQUIRED' });
      expect(await orgOf(t.id)).toBe(org.id);
    }
  });

  it('lists orgId and orgName, and still deletes assets after reassignment', async () => {
    const imported = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(
        basicPackage({
          'wallet.template.json': JSON.stringify(manifest('Moves Around')),
        }),
      ),
      name: 'Moves Around',
    });
    if (!imported.result) throw new Error('Draft import failed');
    const t = { id: imported.result.templateId };
    const author = await member(org.id, ['template_author']);
    expect((await patch(t.id, { orgId: otherOrg.id }, author.headers)).status).toBe(403);
    expect(await orgOf(t.id)).toBe(org.id);
    await addMembership(author.userId, otherOrg.id, ['template_author']);
    // Only a platform grant sets a template's org, so an author of both orgs cannot move it either.
    expect((await patch(t.id, { orgId: otherOrg.id }, author.headers)).status).toBe(403);
    expect(await orgOf(t.id)).toBe(org.id);
    expect((await patch(t.id, { orgId: otherOrg.id })).status).toBe(200);
    expect((await patch(t.id, { orgId: null }, author.headers)).status).toBe(403);
    const list = (await (await call(`?orgId=${otherOrg.id}`)).json()) as {
      items: { id: string; orgId: string | null; orgName: string | null }[];
    };
    const row = list.items.find((i) => i.id === t.id);
    expect(row?.orgId).toBe(otherOrg.id);
    expect(row?.orgName).toEqual(expect.any(String));
    expect(list.items.some((i) => i.orgId === null && i.orgName === null)).toBe(true);
    expect(await (await call(`/${t.id}`, { method: 'DELETE' })).json()).toEqual({
      ok: true,
      outcome: 'deleted',
    });
    expect(
      (await env.BUCKET.list({ prefix: `templates/${org.id}/${t.id}/` })).objects,
    ).toHaveLength(0);
  });

  it('reserves unscoped platform uploads for a platform administrator', async () => {
    const zip = zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest('No Org')) }));
    const author = await member(org.id, ['template_author']);
    expect((await upload(zip, 'name=No+Org', author.headers)).status).toBe(403);
    const accepted = await upload(zip, 'name=No+Org');
    expect(accepted.status).toBe(202);
    const { uploadId } = (await accepted.json()) as { uploadId: string };
    expect((await call(`/uploads/${uploadId}`)).status).toBe(200);
    expect((await call(`/uploads/${uploadId}`, {}, author.headers)).status).toBe(404);
    expect(
      (await call(`/uploads/${uploadId}`, {}, auth.apiKey({ scopes: ['templates:read'] }))).status,
    ).toBe(200);
  });

  it('keeps global imports out of selected session lists while preserving API key behavior', async () => {
    const scopedOrg = await makeOrg(f);
    await addMembership(adminId, scopedOrg.id, ['org_admin']);
    const reader = await member(scopedOrg.id, ['read_only']);
    const zip = zipOf(basicPackage());
    const global = await upload(zip, 'name=Global+List+Scope');
    const tenant = await upload(zip, `orgId=${scopedOrg.id}&name=Tenant+List+Scope`);
    expect(global.status).toBe(202);
    expect(tenant.status).toBe(202);
    const globalId = ((await global.json()) as { uploadId: string }).uploadId;
    const tenantId = ((await tenant.json()) as { uploadId: string }).uploadId;
    const uploadIds = async (path: string, headers: Record<string, string>) => {
      const response = await call(path, {}, headers);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: { uploadId: string }[] };
      return body.items.map((item) => item.uploadId);
    };
    const scopedPath = `/uploads?orgId=${scopedOrg.id}&limit=20`;
    for (const headers of [admin, reader.headers]) {
      const ids = await uploadIds(scopedPath, headers);
      expect(ids).toContain(tenantId);
      expect(ids).not.toContain(globalId);
    }
    const unscoped = await uploadIds('/uploads?limit=20', admin);
    expect(unscoped).toContain(globalId);
    expect(unscoped).not.toContain(tenantId);
    const key = auth.apiKey({ orgId: scopedOrg.id, scopes: ['templates:read'] });
    const keyIds = await uploadIds(scopedPath, key);
    expect(keyIds).toContain(tenantId);
    expect(keyIds).toContain(globalId);
  });
});

describe('contract', () => {
  it('publishes the template paths in OpenAPI', async () => {
    const doc = (await (await app.request(`${ORIGIN}/api/v1/openapi.json`, {}, env)).json()) as {
      paths: Record<string, unknown>;
    };
    for (const p of [
      '/api/v1/templates/{id}/versions/{version}',
      '/api/v1/templates/{id}/versions/{version}/assets/{name}',
      '/api/v1/templates/uploads/{id}',
    ])
      expect(doc.paths).toHaveProperty([p]);
  });

  it('never leaks internal storage keys in DTOs', async () => {
    const text = await (await call(`/${templateId}`)).text();
    expect(text).not.toContain('templates/');
  });
});
