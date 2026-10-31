import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { buildPass } from '../../../passkit/build.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createEnvIdentityResolver } from '../identities/resolver.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { clearTemplateCache, createTemplateRegistry } from './registry.ts';
import { resetBakedSync, syncBakedTemplates } from './sync.ts';
import { type BakedFixture, bakedFrom, fakeAssets, importZip, sourceOf } from './testing.ts';

let env: AppEnv;
let clock: ManualClock;
let org: { id: string; slug: string; name: string };
let platform: BakedFixture;
let owned: BakedFixture;
let assets: ReturnType<typeof fakeAssets>;

const count = async (sql: string) => (await first<{ n: number }>(env.DB, sql))?.n ?? 0;
const ctx = () => createServiceContext(env, { clock });

beforeAll(async () => {
  clock = new ManualClock(Date.now());
  assets = fakeAssets();
  env = await makeEnv({ ASSETS: assets });
  org = await makeOrg(fixtures(env, clock), { slug: 'acme', name: 'Acme' });
  platform = await bakedFrom('starter', basicPackage(), { name: 'Starter' });
  owned = await bakedFrom('acme-card', basicPackage({ 'logo.png': makePng(100, 40) }), {
    name: 'Acme Card',
    org: { slug: 'acme', name: 'Acme Corp' },
  });
  for (const f of [platform, owned]) for (const [k, v] of f.files) assets.files.set(k, v);
});

beforeEach(() => resetBakedSync());

describe('syncBakedTemplates', () => {
  it('upserts orgs, templates and versions, and links the baked org by slug', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h1'));
    const rows = await all<{
      id: string;
      org_id: string | null;
      active_version: string;
      origin: string;
    }>(
      env.DB,
      "SELECT id, org_id, active_version, origin FROM templates WHERE origin = 'baked' ORDER BY id",
    );
    expect(rows.map((r) => r.id)).toEqual(['baked:acme-card', 'baked:starter']);
    expect(rows[0]?.org_id).toBe(org.id);
    expect(rows[1]?.org_id).toBeNull();
    expect(rows[1]?.active_version).toBe(platform.template.version);
    expect(
      await count("SELECT COUNT(*) AS n FROM template_versions WHERE template_id LIKE 'baked:%'"),
    ).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM orgs WHERE slug = 'acme'")).toBe(1);
    const name = await first<{ name: string }>(env.DB, "SELECT name FROM orgs WHERE slug = 'acme'");
    expect(name?.name).toBe('Acme');
  });

  it('creates a baked org that does not exist yet', async () => {
    const fresh = await bakedFrom('newco-card', basicPackage(), {
      name: 'Newco',
      org: { slug: 'newco', name: 'Newco' },
    });
    await syncBakedTemplates(ctx(), sourceOf([fresh], 'h-new'));
    expect(await count("SELECT COUNT(*) AS n FROM orgs WHERE slug = 'newco'")).toBe(1);
    const t = await first<{ org_id: string }>(
      env.DB,
      "SELECT org_id FROM templates WHERE id = 'baked:newco-card'",
    );
    expect(t?.org_id).not.toBeNull();
  });

  it('is idempotent: same hash writes nothing, repeated syncs keep one row each', async () => {
    const source = sourceOf([platform, owned], 'h1');
    await syncBakedTemplates(ctx(), source);
    const before = await first<{ updated_at: number }>(
      env.DB,
      "SELECT updated_at FROM templates WHERE id = 'baked:starter'",
    );
    clock.advance(60_000);
    resetBakedSync();
    await syncBakedTemplates(ctx(), source);
    await syncBakedTemplates(ctx(), source);
    const after = await first<{ updated_at: number }>(
      env.DB,
      "SELECT updated_at FROM templates WHERE id = 'baked:starter'",
    );
    expect(after?.updated_at).toBe(before?.updated_at);
    expect(await count("SELECT COUNT(*) AS n FROM templates WHERE id = 'baked:starter'")).toBe(1);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM template_versions WHERE template_id = 'baked:starter'",
      ),
    ).toBe(1);
  });

  it('runs once per isolate per hash', async () => {
    const source = sourceOf([platform], 'h-once');
    const a = syncBakedTemplates(ctx(), source);
    const b = syncBakedTemplates(ctx(), source);
    expect(a).toBe(b);
    await a;
  });

  it('applies a changed build without touching existing org names, and keeps old versions', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform], 'h2'));
    const next = await bakedFrom('starter', basicPackage({ 'logo.png': makePng(80, 30) }), {
      name: 'Starter v2',
    });
    clock.advance(1000);
    await syncBakedTemplates(ctx(), sourceOf([next], 'h3'));
    const row = await first<{ name: string; active_version: string }>(
      env.DB,
      "SELECT name, active_version FROM templates WHERE id = 'baked:starter'",
    );
    expect(row).toEqual({ name: 'Starter v2', active_version: next.template.version });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM template_versions WHERE template_id = 'baked:starter'",
      ),
    ).toBe(2);
  });

  it('archives baked templates that left the build', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h4'));
    await syncBakedTemplates(ctx(), sourceOf([platform], 'h5'));
    const gone = await first<{ status: string }>(
      env.DB,
      "SELECT status FROM templates WHERE id = 'baked:acme-card'",
    );
    expect(gone?.status).toBe('archived');
    await syncBakedTemplates(ctx(), sourceOf([], 'h6'));
    expect(
      (
        await first<{ status: string }>(
          env.DB,
          "SELECT status FROM templates WHERE id = 'baked:starter'",
        )
      )?.status,
    ).toBe('archived');
  });

  it('does not retry a failed sync from the cache', async () => {
    const broken = { ...sourceOf([platform], 'h-broken') };
    const failing = createServiceContext(
      {
        ...env,
        DB: {
          prepare: () => {
            throw new Error('db down');
          },
        } as unknown as D1Database,
      } as AppEnv,
      { clock },
    );
    await expect(syncBakedTemplates(failing, broken)).rejects.toThrow('db down');
    await expect(syncBakedTemplates(ctx(), broken)).resolves.toBeUndefined();
  });
});

describe('CompositeTemplateRegistry', () => {
  const registry = (source = sourceOf([platform, owned], 'reg')) =>
    createTemplateRegistry(env, { source, ctx: ctx() });

  it('resolves a baked template, defaulting to the current version', async () => {
    const r = await registry().resolve('baked:starter');
    expect(r).toMatchObject({
      id: 'baked:starter',
      origin: 'baked',
      version: platform.template.version,
      orgId: null,
      styles: ['generic'],
    });
    expect(r.assets.map((a) => a.source.kind)).toEqual(['static', 'static']);
    expect((await registry().resolve('baked:starter', platform.template.version)).version).toBe(
      platform.template.version,
    );
  });

  it('gives a baked org template its org id', async () => {
    expect((await registry().resolve('baked:acme-card')).orgId).toBe(org.id);
  });

  it('opens baked assets through the ASSETS binding', async () => {
    const reg = registry();
    const r = await reg.resolve('baked:starter');
    const bytes = new Uint8Array(
      await new Response(await reg.openAsset(r, 'icon.png')).arrayBuffer(),
    );
    expect(bytes).toEqual(basicPackage().get('icon.png'));
    await expect(reg.openAsset(r, 'nope.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    assets.files.delete(r.assets[0]?.source.kind === 'static' ? r.assets[0].source.path : '');
    await expect(reg.openAsset(r, 'icon.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    assets.files.set(r.assets[0]?.source.kind === 'static' ? r.assets[0].source.path : '', bytes);
  });

  it('treats the SPA fallback page as a missing static asset', async () => {
    const spa = await makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      } as unknown as Fetcher,
    });
    const reg = createTemplateRegistry(spa, { source: sourceOf([platform], 'reg'), ctx: ctx() });
    const r = await reg.resolve('baked:starter');
    await expect(reg.openAsset(r, 'icon.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('serves baked extras that are not in the bundle', async () => {
    const withExtra = await bakedFrom('extra', basicPackage({ 'strip.png': makePng(375, 144) }), {
      name: 'Extra',
    });
    for (const [k, v] of withExtra.files) assets.files.set(k, v);
    const reg = registry(sourceOf([withExtra], 'reg-extra'));
    const r = await reg.resolve('baked:extra');
    expect(r.assets.map((a) => a.name)).not.toContain('strip.png');
    const bytes = new Uint8Array(
      await new Response(await reg.openExtra(r, 'strip.png')).arrayBuffer(),
    );
    expect(bytes.length).toBeGreaterThan(0);
    await expect(reg.openExtra(r, 'other.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('rejects unknown templates and unknown versions', async () => {
    await expect(registry().resolve('baked:ghost')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      status: 404,
    });
    await expect(registry().resolve('01900000-0000-7000-8000-000000000000')).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
    await expect(registry().resolve('baked:starter', 'deadbeef')).rejects.toMatchObject({
      code: 'TEMPLATE_VERSION_NOT_FOUND',
    });
  });

  it('resolves uploaded templates from D1 and R2, with and without a version', async () => {
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Uploaded One',
    });
    const b = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage({ 'logo.png': makePng(100, 40) })),
      name: 'Uploaded One',
    });
    const id = a.result?.templateId ?? '';
    const reg = registry();
    const active = await reg.resolve(id);
    expect(active).toMatchObject({ origin: 'uploaded', orgId: org.id, version: b.result?.version });
    const old = await reg.resolve(id, a.result?.version);
    expect(old.version).toBe(a.result?.version);
    expect(old.assets.map((x) => x.name)).toEqual(['icon.png', 'icon@2x.png']);
    const bytes = new Uint8Array(
      await new Response(await reg.openAsset(old, 'icon.png')).arrayBuffer(),
    );
    expect(bytes).toEqual(basicPackage().get('icon.png'));
    await expect(reg.resolve(id, 'nope')).rejects.toMatchObject({
      code: 'TEMPLATE_VERSION_NOT_FOUND',
    });
  });

  it('caches immutable resolutions per isolate', async () => {
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Cached',
    });
    const id = a.result?.templateId ?? '';
    const reg = registry();
    const first1 = await reg.resolve(id, a.result?.version);
    await run(env.DB, 'UPDATE templates SET active_version = active_version WHERE id = ?', [id]);
    expect(await reg.resolve(id, a.result?.version)).toBe(first1);
    expect(await registry().resolve(id, a.result?.version)).toBe(first1);
    clearTemplateCache(env, id);
    expect(await reg.resolve(id, a.result?.version)).not.toBe(first1);
  });

  it('keeps resolving archived templates but not deleted ones', async () => {
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Archived',
    });
    const id = a.result?.templateId ?? '';
    await run(env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [id]);
    expect((await registry().resolve(id, a.result?.version)).id).toBe(id);
    clearTemplateCache(env, id);
    await run(env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [id]);
    await expect(registry().resolve(id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('lists by org: that org plus platform templates, hiding archived by default', async () => {
    const other = await makeOrg(fixtures(env, clock), { slug: 'other-org' });
    const mine = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'List Mine',
    });
    const theirs = await importZip(env, clock, {
      orgId: other.id,
      zip: zipOf(basicPackage()),
      name: 'List Theirs',
    });
    const reg = registry();
    const ids = (await reg.list({ orgId: org.id })).map((t) => t.id);
    expect(ids).toContain(mine.result?.templateId);
    expect(ids).toContain('baked:starter');
    expect(ids).not.toContain(theirs.result?.templateId);
    expect((await reg.list({ orgId: null })).every((t) => t.orgId === null)).toBe(true);
    await run(env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [
      mine.result?.templateId ?? '',
    ]);
    expect((await reg.list({ orgId: org.id })).map((t) => t.id)).not.toContain(
      mine.result?.templateId,
    );
    expect((await reg.list({ orgId: org.id, includeArchived: true })).map((t) => t.id)).toContain(
      mine.result?.templateId,
    );
  });

  it('builds and signs a pass from a resolved uploaded template', async () => {
    const manifest = JSON.stringify({
      schema: 1,
      name: 'Buildable',
      inputs: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      sample: { name: 'Alex' },
      bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
      display: { title: '{{name}}' },
    });
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage({ 'wallet.template.json': manifest })),
      name: 'Buildable',
    });
    const reg = registry();
    const template = await reg.resolve(a.result?.templateId ?? '');
    const identity = await createEnvIdentityResolver(env).platform();
    const built = await buildPass({
      template,
      registry: reg,
      input: { name: 'Sam Rivera' },
      server: {
        serial: 's-1',
        authToken: 'a'.repeat(32),
        webServiceURL: 'https://wallet.test/wallet',
        organizationName: 'Acme',
        identity,
      },
      signing: identity.material,
      now: new Date(clock.now()),
    });
    expect(Object.keys(built.signed.files).sort()).toEqual([
      'icon.png',
      'icon@2x.png',
      'manifest.json',
      'pass.json',
      'signature',
    ]);
    expect(built.passJson.generic?.primaryFields?.[0]?.value).toBe('Sam Rivera');
  });
});
