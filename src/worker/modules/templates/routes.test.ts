import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { createTemplateRegistry } from './registry.ts';
import { generatedSource } from './sync.ts';
import { fakeAssets, importZip } from './testing.ts';

const ORIGIN = 'https://wallet.test';
const auth = fakeAuth(ORIGIN);
const workflows: { id: string; params: unknown }[] = [];
const imports: { id: string; params: unknown }[] = [];
let failImportStart = false;

let env: AppEnv;
let clock: ManualClock;
let f: Fixtures;
let app: ReturnType<typeof createApp>;
let org: { id: string; slug: string };
let otherOrg: { id: string; slug: string };
let admin: Record<string, string>;
let user: Record<string, string>;
let adminId: string;
let templateId: string;
let version: string;

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
  const r = await importZip(env, clock, {
    orgId,
    zip: zipOf(basicPackage({ 'wallet.template.json': JSON.stringify(manifest(name)), ...extra })),
    name,
    createdBy: adminId,
  });
  return { id: r.result?.templateId ?? '', version: r.result?.version ?? '' };
}

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  const assets = fakeAssets();
  for (const t of generatedSource.templates)
    for (const a of t.assets) assets.files.set(a.source.path, new Uint8Array([1, 2, 3]));
  env = await makeEnv({
    ASSETS: assets,
    BULK_REISSUE: {
      create: async (o: { id: string; params: unknown }) => {
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
  app = createApp({ stores: auth.stores });
  org = await makeOrg(f);
  otherOrg = await makeOrg(f);
  adminId = (await makeUser(f)).id;
  admin = auth.session({ userId: adminId, roles: ['admin', 'user'] });
  user = auth.user((await makeUser(f)).id);
  ({ id: templateId, version } = await seed(org.id, 'Route Card'));
});

describe('auth', () => {
  it('requires a session or API key', async () => {
    expect((await call('', {}, {})).status).toBe(401);
    expect((await call(`/${templateId}`, {}, {})).status).toBe(401);
  });

  it('lets admins and templates:read keys read; rejects plain users and keys without the scope', async () => {
    expect((await call('', {}, admin)).status).toBe(200);
    expect((await call('', {}, auth.apiKey({ scopes: ['templates:read'] }))).status).toBe(200);
    expect((await call('', {}, user)).status).toBe(403);
    const noScope = await call('', {}, auth.apiKey({ scopes: ['passes:read'] }));
    expect(noScope.status).toBe(403);
    expect(await noScope.json()).toMatchObject({ code: 'MISSING_SCOPE' });
  });

  it('keeps every write admin only', async () => {
    const key = auth.apiKey({ scopes: ['templates:read', 'passes:write'] });
    const attempts: [string, string, RequestInit][] = [
      ['POST', '/uploads?orgId=x', { body: zipOf(basicPackage()) }],
      ['DELETE', `/${templateId}`, {}],
      ['POST', `/${templateId}/clone`, json({ orgId: org.id })],
      ['POST', `/${templateId}/activate`, json({ version })],
      ['PUT', `/${templateId}/manifest`, json({ manifest: manifest('x') })],
      ['POST', `/${templateId}/preview`, json({})],
    ];
    for (const [method, path, init] of attempts) {
      for (const headers of [key, user]) {
        const res = await call(path, { method, ...init }, headers);
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
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
    const denied = await call(`/${templateId}`, {}, other);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'ORG_FORBIDDEN' });
    expect((await call(`/${templateId}/versions/${version}`, {}, other)).status).toBe(403);
    expect(
      (await call(`/${templateId}/versions/${version}/assets/icon.png`, {}, other)).status,
    ).toBe(403);
    expect((await call(`?orgId=${org.id}`, {}, other)).status).toBe(403);
    expect((await call('/baked:starter-generic', {}, other)).status).toBe(200);
  });

  it('platform keys and admins may filter by any org', async () => {
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
    const other = auth.apiKey({ orgId: otherOrg.id, scopes: ['templates:read'] });
    expect((await call(`/uploads/${r.p.uploadId}`, {}, other)).status).toBe(403);
    expect((await call(`/uploads/${r.p.uploadId}`)).status).toBe(200);
  });
});

describe('read', () => {
  it('lists with origin and status filters and paginates', async () => {
    const baked = (await (await call('?origin=baked')).json()) as { items: { origin: string }[] };
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
    expect((await call('?cursor=garbage')).status).toBe(422);
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

  it('serves assets with immutable caching, ETag and 304', async () => {
    const res = await call(`/${templateId}/versions/${version}/assets/icon.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(basicPackage().get('icon.png'));
    const etag = res.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const cached = await call(`/${templateId}/versions/${version}/assets/icon.png`, {
      headers: { 'if-none-match': etag },
    });
    expect(cached.status).toBe(304);
    expect((await call(`/${templateId}/versions/${version}/assets/missing.png`)).status).toBe(404);
    expect((await call(`/${templateId}/versions/${version}/assets/pass.json`)).status).toBe(404);
    expect((await call(`/${templateId}/versions/deadbeef/assets/icon.png`)).status).toBe(404);
  });

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

  it('serves baked assets through the ASSETS binding', async () => {
    const baked = generatedSource.templates[0];
    if (!baked) return;
    const asset = baked.assets.find((a) => a.name.endsWith('.png'));
    const res = await call(
      `/${encodeURIComponent(baked.id)}/versions/${baked.version}/assets/${asset?.name}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(`"${asset?.sha1}"`);
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
      },
    });
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
    expect(noOrg.status).toBe(404);
    expect(await noOrg.json()).toMatchObject({ code: 'ORG_NOT_FOUND' });
    expect((await upload(zip(), '')).status).toBe(422);
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
      activeVersion: string;
    };
    expect(body).toMatchObject({
      origin: 'uploaded',
      orgId: org.id,
      slug: 'henry-copy',
      name: 'Henry Copy',
    });
    const v = await createTemplateRegistry(env).resolve(body.id);
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

  it('refuses a duplicate name, an unknown org and a baked-name collision', async () => {
    expect(
      (await post('/baked:henrys-blue/clone', { orgId: org.id, name: 'Henry Copy' })).status,
    ).toBe(409);
    expect(
      (await post('/baked:henrys-blue/clone', { orgId: '01900000-0000-7000-8000-000000000000' }))
        .status,
    ).toBe(404);
    expect((await post('/baked:nope/clone', { orgId: org.id })).status).toBe(404);
  });

  it('clones an uploaded template and names it by default', async () => {
    const res = await post(`/${templateId}/clone`, { orgId: otherOrg.id });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'Route Card copy', orgId: otherOrg.id });
  });
});

describe('activate', () => {
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

  it('switches the active version and audits it', async () => {
    const res = await post(`/${t.id}/activate`, { version: t.version });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activeVersion: t.version });
    expect(
      workflows.filter((w) => (w.params as { templateId: string }).templateId === t.id),
    ).toHaveLength(0);
    const back = (await (await post(`/${t.id}/activate`, { version: v2 })).json()) as {
      activeVersion: string;
      versions: { active: boolean }[];
    };
    expect(back.activeVersion).toBe(v2);
    expect(back.versions.filter((v) => v.active)).toHaveLength(1);
    expect((await createTemplateRegistry(env).resolve(t.id)).version).toBe(v2);
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE action = 'template.activate' AND target_id = ? ORDER BY id DESC",
      [t.id],
    );
    expect(JSON.parse(audit?.detail ?? '{}')).toMatchObject({ version: v2, previous: t.version });
  });

  it('starts a BULK_REISSUE run when asked to rebuild', async () => {
    const res = await post(`/${t.id}/activate`, { version: t.version, rebuildPasses: true });
    expect(res.status).toBe(200);
    const call1 = workflows.find((w) => (w.params as { templateId: string }).templateId === t.id);
    expect(call1?.params).toEqual({
      templateId: t.id,
      version: t.version,
      orgId: org.id,
      cause: 'template_upgrade',
    });
    const run = await first<{ kind: string; target_id: string; status: string }>(
      env.DB,
      'SELECT kind, target_id, status FROM workflow_runs WHERE instance_id = ?',
      [call1?.id ?? ''],
    );
    expect(run).toEqual({ kind: 'bulk_reissue', target_id: t.id, status: 'queued' });
  });

  it('rejects unknown versions, baked templates and archived templates', async () => {
    expect((await post(`/${t.id}/activate`, { version: 'nope' })).status).toBe(404);
    const baked = await post('/baked:henrys-blue/activate', { version: 'x' });
    expect(baked.status).toBe(403);
    expect(await baked.json()).toMatchObject({ code: 'TEMPLATE_BAKED' });
    const gone = await seed(org.id, 'Archived Activate');
    await f.env.DB.prepare("UPDATE templates SET status = 'archived' WHERE id = ?")
      .bind(gone.id)
      .run();
    expect((await post(`/${gone.id}/activate`, { version: gone.version })).status).toBe(409);
  });

  it('refuses a version that failed validation', async () => {
    const bad = await seed(org.id, 'Invalid Version');
    await f.env.DB.prepare(
      'INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_at) SELECT template_id, \'bad1\', manifest, pass_json, assets, \'{"ok":false,"issues":[]}\', created_at FROM template_versions WHERE template_id = ?',
    )
      .bind(bad.id)
      .run();
    expect((await post(`/${bad.id}/activate`, { version: 'bad1' })).status).toBe(409);
  });
});

describe('manifest', () => {
  it('creates and activates a new version from a valid manifest', async () => {
    const t = await seed(org.id, 'Edit Manifest');
    const next = { ...manifest('Edit Manifest'), display: { title: 'Fixed title' } };
    const res = await call(`/${t.id}/manifest`, { method: 'PUT', ...json({ manifest: next }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activeVersion: string; versions: unknown[] };
    expect(body.activeVersion).not.toBe(t.version);
    expect(body.versions).toHaveLength(2);
    const same = await call(`/${t.id}/manifest`, { method: 'PUT', ...json({ manifest: next }) });
    expect(((await same.json()) as { versions: unknown[] }).versions).toHaveLength(2);
    const resolved = await createTemplateRegistry(env).resolve(t.id);
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
    expect(problem.issues.map((i) => i.code)).toContain('SCHEMA_KEYWORD');
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
