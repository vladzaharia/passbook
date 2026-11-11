import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countD1, fixtures, makeEnv, makeOrg } from '../../../../test/helpers/index.ts';
import { buildPass } from '../../../passkit/build.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createEnvIdentityResolver } from '../identities/resolver.ts';
import { basicPackage, makePng, zipOf } from './package/fixtures.ts';
import { clearTemplateCache, createTemplateRegistry } from './registry.ts';
import { templateContentHash } from './release-content.ts';
import { listVersionExtras } from './repo-preview-extras.ts';
import { bakedExtraR2Key, bakedR2Key, resetBakedSync, syncBakedTemplates } from './sync.ts';
import { type BakedFixture, bakedFrom, fakeAssets, importZip, sourceOf } from './testing.ts';

let env: AppEnv;
let clock: ManualClock;
let org: { id: string; slug: string; name: string };
let platform: BakedFixture;
let owned: BakedFixture;
let assets: ReturnType<typeof fakeAssets>;
let buildNumber = 0;

const advanceBuild = () => {
  const build = ++buildNumber;
  env = {
    ...env,
    CF_VERSION: {
      id: `registry-test-worker-${build}`,
      tag: '',
      timestamp: new Date(Date.UTC(2040, 0, 1) + build * 1000).toISOString(),
    },
  };
};
const count = async (sql: string) => (await first<{ n: number }>(env.DB, sql))?.n ?? 0;
const ctx = () => createServiceContext(env, { clock });
const serve = (fixture: BakedFixture) => {
  for (const [k, v] of fixture.files) assets.files.set(k, v);
  return fixture;
};
const storedAssets = (fixture: BakedFixture) =>
  fixture.template.assets.map((asset) => ({
    ...asset,
    source: {
      kind: 'r2' as const,
      key: bakedR2Key(fixture.template.slug, fixture.template.version, asset.name),
    },
  }));

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
});

beforeEach(() => {
  resetBakedSync();
  clearTemplateCache(env);
  assets.files.clear();
  for (const fixture of [platform, owned]) serve(fixture);
  advanceBuild();
});

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
    const keys = await all<{ build_key: string | null }>(
      env.DB,
      "SELECT build_key FROM template_versions WHERE template_id LIKE 'baked:%'",
    );
    expect(keys).toHaveLength(2);
    for (const row of keys) expect(row.build_key).toMatch(/^[0-9a-f]{64}$/);
    const versions = await all<{
      template_id: string;
      manifest: string;
      pass_json: string;
      assets: string;
    }>(
      env.DB,
      "SELECT template_id, manifest, pass_json, assets FROM template_versions WHERE template_id LIKE 'baked:%'",
    );
    for (const fixture of [platform, owned]) {
      const version = versions.find((row) => row.template_id === fixture.template.id);
      expect(version).toBeDefined();
      expect(JSON.parse(version?.manifest ?? 'null')).toEqual(fixture.template.manifest);
      expect(JSON.parse(version?.pass_json ?? 'null')).toEqual(fixture.template.passJson);
      expect(JSON.parse(version?.assets ?? 'null')).toEqual(storedAssets(fixture));
      for (const asset of fixture.template.assets) {
        const object = await env.BUCKET.get(
          bakedR2Key(fixture.template.slug, fixture.template.version, asset.name),
        );
        expect(object).not.toBeNull();
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(
          fixture.files.get(asset.source.path),
        );
      }
    }
    const releases = await all<{
      template_id: string;
      org_id: string | null;
      mode: string;
      version: string;
      source: string;
    }>(
      env.DB,
      "SELECT template_id, org_id, mode, version, source FROM template_releases WHERE template_id LIKE 'baked:%' ORDER BY template_id, mode",
    );
    expect(releases).toEqual([
      {
        template_id: owned.template.id,
        org_id: org.id,
        mode: 'live',
        version: owned.template.version,
        source: 'system',
      },
      {
        template_id: owned.template.id,
        org_id: org.id,
        mode: 'test',
        version: owned.template.version,
        source: 'system',
      },
      {
        template_id: platform.template.id,
        org_id: null,
        mode: 'live',
        version: platform.template.version,
        source: 'system',
      },
      {
        template_id: platform.template.id,
        org_id: null,
        mode: 'test',
        version: platform.template.version,
        source: 'system',
      },
    ]);
    expect(await count("SELECT COUNT(*) AS n FROM orgs WHERE slug = 'acme'")).toBe(1);
    const name = await first<{ name: string }>(env.DB, "SELECT name FROM orgs WHERE slug = 'acme'");
    expect(name?.name).toBe('Acme');
  });

  it('never overwrites an admin assignment on later syncs, NULL included', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h-assign-1'));
    await env.DB.prepare("UPDATE templates SET org_id = NULL WHERE id = 'baked:acme-card'").run();
    await env.DB.prepare('UPDATE templates SET org_id = ? WHERE id = ?')
      .bind(org.id, 'baked:starter')
      .run();
    resetBakedSync();
    advanceBuild();
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h-assign-2'));
    const rows = await all<{ id: string; org_id: string | null }>(
      env.DB,
      "SELECT id, org_id FROM templates WHERE id IN ('baked:acme-card', 'baked:starter') ORDER BY id",
    );
    expect(rows.map((r) => r.org_id)).toEqual([null, org.id]);
    await env.DB.prepare('UPDATE templates SET org_id = ? WHERE id = ?')
      .bind(org.id, 'baked:acme-card')
      .run();
    await env.DB.prepare("UPDATE templates SET org_id = NULL WHERE id = 'baked:starter'").run();
  });

  it('creates a baked org that does not exist yet', async () => {
    const fresh = serve(
      await bakedFrom('newco-card', basicPackage(), {
        name: 'Newco',
        org: { slug: 'newco', name: 'Newco' },
      }),
    );
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

  it('checks persisted release readiness before skipping a settled sync', async () => {
    const source = sourceOf([platform], 'h-once');
    const counted = countD1(env.DB);
    const traced: AppEnv = { ...env, DB: counted.db };
    await syncBakedTemplates(createServiceContext(traced, { clock }), source);
    counted.reset();
    const withoutStaticAssets: AppEnv = {
      ...traced,
      ASSETS: {
        fetch: () => {
          throw new Error('a settled sync should not fetch static assets');
        },
      } as unknown as Fetcher,
    };
    await expect(
      syncBakedTemplates(createServiceContext(withoutStaticAssets, { clock }), source),
    ).resolves.toBeUndefined();
    // Release readiness, then the sealed extras; no adoption snapshot, no write.
    expect(counted.count()).toBe(2);
    expect(counted.sql()[0]).toContain('template_releases');
    expect(counted.sql()[1]).toContain('template_version_extra_sets');
    for (const sql of counted.sql()) expect(sql.trimStart()).toMatch(/^SELECT\b/);
  });

  it('keeps a replaced baked version buildable from R2 after its static files are gone', async () => {
    const oldFiles = basicPackage({ 'logo.png': makePng(100, 40) });
    const newFiles = basicPackage({ 'logo.png': makePng(90, 30) });
    const oldV = serve(await bakedFrom('redeploy', oldFiles, { name: 'Redeploy' }));
    await syncBakedTemplates(ctx(), sourceOf([oldV], 'h-redeploy-1'));
    const newV = serve(await bakedFrom('redeploy', newFiles, { name: 'Redeploy' }));
    advanceBuild();
    await syncBakedTemplates(ctx(), sourceOf([newV], 'h-redeploy-2'));
    for (const path of oldV.files.keys()) assets.files.delete(path);

    clearTemplateCache(env);
    const reg = createTemplateRegistry(env, {
      source: sourceOf([newV], 'h-redeploy-2'),
      ctx: ctx(),
    });
    const old = await reg.resolve('baked:redeploy', oldV.template.version);
    expect(old.manifest).toEqual(oldV.template.manifest);
    expect(old.passJson).toEqual(oldV.template.passJson);
    expect(old.assets).toEqual(storedAssets(oldV));
    const bytes = new Uint8Array(
      await new Response(await reg.openAsset(old, 'icon.png')).arrayBuffer(),
    );
    expect(bytes).toEqual(oldFiles.get('icon.png'));
    const oldLogo = new Uint8Array(
      await new Response(await reg.openAsset(old, 'logo.png')).arrayBuffer(),
    );
    expect(oldLogo).toEqual(oldFiles.get('logo.png'));
    expect(oldLogo).not.toEqual(newFiles.get('logo.png'));
    const current = await reg.resolve('baked:redeploy');
    expect(current.version).toBe(newV.template.version);
    expect(current.assets).toEqual(storedAssets(newV));
    const currentLogo = new Uint8Array(
      await new Response(await reg.openAsset(current, 'logo.png')).arrayBuffer(),
    );
    expect(currentLogo).toEqual(newFiles.get('logo.png'));
    const releases = await all<{
      mode: string;
      version: string;
      generation: number;
      source: string;
    }>(
      env.DB,
      "SELECT mode, version, generation, source FROM template_releases WHERE template_id = 'baked:redeploy' ORDER BY mode, generation",
    );
    expect(releases).toEqual([
      { mode: 'live', version: oldV.template.version, generation: 1, source: 'system' },
      { mode: 'live', version: newV.template.version, generation: 2, source: 'system' },
      { mode: 'test', version: oldV.template.version, generation: 1, source: 'system' },
      { mode: 'test', version: newV.template.version, generation: 2, source: 'system' },
    ]);
  });

  it('applies a changed build without touching existing org names, and keeps old versions', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h2'));
    const next = serve(
      await bakedFrom('starter', basicPackage({ 'logo.png': makePng(80, 30) }), {
        name: 'Starter v2',
      }),
    );
    clock.advance(1000);
    advanceBuild();
    await syncBakedTemplates(ctx(), sourceOf([next, owned], 'h3'));
    const row = await first<{ name: string; active_version: string }>(
      env.DB,
      "SELECT name, active_version FROM templates WHERE id = 'baked:starter'",
    );
    expect(row).toEqual({ name: 'Starter v2', active_version: next.template.version });
    const orgRow = await first<{ name: string }>(
      env.DB,
      "SELECT name FROM orgs WHERE slug = 'acme'",
    );
    expect(orgRow).toEqual({ name: 'Acme' });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM template_versions WHERE template_id = 'baked:starter'",
      ),
    ).toBe(2);
  });

  it('lets an older worker skip the sync and serve the database, on reads and on syncs', async () => {
    const initial = serve(
      await bakedFrom('stale-worker', basicPackage(), { name: 'Stale Worker' }),
    );
    const oldContext = ctx();
    const oldSource = sourceOf([initial], 'h-stale-1');
    await syncBakedTemplates(oldContext, oldSource);
    const next = serve(
      await bakedFrom('stale-worker', basicPackage({ 'logo.png': makePng(90, 30) }), {
        name: 'Newer worker',
      }),
    );
    advanceBuild();
    const nextSource = sourceOf([next], 'h-stale-2');
    await syncBakedTemplates(ctx(), nextSource);
    const releases = await all<{ id: string; mode: string; version: string; generation: number }>(
      env.DB,
      'SELECT id, mode, version, generation FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
      [initial.template.id],
    );
    expect(
      releases.map(({ mode, version, generation }) => ({ mode, version, generation })),
    ).toEqual([
      { mode: 'live', version: initial.template.version, generation: 1 },
      { mode: 'live', version: next.template.version, generation: 2 },
      { mode: 'test', version: initial.template.version, generation: 1 },
      { mode: 'test', version: next.template.version, generation: 2 },
    ]);
    resetBakedSync();
    await expect(syncBakedTemplates(oldContext, oldSource)).resolves.toBeUndefined();
    const oldRegistry = createTemplateRegistry(oldContext.env, {
      source: oldSource,
      ctx: oldContext,
    });
    const served = await oldRegistry.resolve(initial.template.id);
    expect(served.version).toBe(next.template.version);
    expect((await oldRegistry.list({})).map((entry) => entry.id)).toContain(initial.template.id);
    // A settled skip costs one adoption read per call, not a sync attempt.
    const counted = countD1(env.DB);
    const settled = createServiceContext({ ...oldContext.env, DB: counted.db }, { clock });
    await syncBakedTemplates(settled, oldSource);
    counted.reset();
    await syncBakedTemplates(settled, oldSource);
    expect(counted.count()).toBe(1);
    expect(counted.sql()[0]).toContain('settings');
    const active = await first<{ active_version: string }>(
      env.DB,
      'SELECT active_version FROM templates WHERE id = ?',
      [initial.template.id],
    );
    expect(active).toEqual({ active_version: next.template.version });
    const after = await all(
      env.DB,
      'SELECT id, mode, version, generation FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
      [initial.template.id],
    );
    expect(after).toEqual(releases);
  });

  it('treats an equal baked hash as a no-op for any ordered worker build', async () => {
    const source = sourceOf([platform], 'h-equal');
    await syncBakedTemplates(ctx(), source);
    const snapshot = async () => ({
      settings: await all(
        env.DB,
        "SELECT key, value, updated_at FROM settings WHERE scope = 'system' ORDER BY key",
      ),
      templates: await all(env.DB, "SELECT id, updated_at FROM templates WHERE origin = 'baked'"),
      releases: await all(env.DB, 'SELECT id FROM template_releases ORDER BY id'),
      audits: await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'template.release'"),
    });
    const before = await snapshot();
    clock.advance(60_000);
    for (const timestamp of [
      '2041-01-01T00:00:00.000Z',
      '2039-12-31T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    ]) {
      resetBakedSync();
      const worker: AppEnv = {
        ...env,
        CF_VERSION: { id: `equal-${timestamp}`, tag: '', timestamp },
      };
      await expect(
        syncBakedTemplates(createServiceContext(worker, { clock }), source),
      ).resolves.toBeUndefined();
      expect(await snapshot()).toEqual(before);
    }
  });

  it('archives baked templates that left the build', async () => {
    await syncBakedTemplates(ctx(), sourceOf([platform, owned], 'h4'));
    advanceBuild();
    await syncBakedTemplates(ctx(), sourceOf([platform], 'h5'));
    const gone = await first<{ status: string }>(
      env.DB,
      "SELECT status FROM templates WHERE id = 'baked:acme-card'",
    );
    expect(gone?.status).toBe('archived');
    advanceBuild();
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

  it('retries a sync that failed instead of caching it', async () => {
    const source = sourceOf([platform], 'h-broken');
    let unavailable = true;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare' && unavailable) {
          return () => {
            throw new Error('db down');
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const retryContext = createServiceContext({ ...env, DB: db }, { clock });
    await expect(syncBakedTemplates(retryContext, source)).rejects.toThrow('db down');
    unavailable = false;
    await expect(syncBakedTemplates(retryContext, source)).resolves.toBeUndefined();
    const stored = await first<{ active_version: string }>(
      env.DB,
      "SELECT active_version FROM templates WHERE id = 'baked:starter'",
    );
    expect(stored).toEqual({ active_version: platform.template.version });
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
    expect(r.manifest).toEqual(platform.template.manifest);
    expect(r.passJson).toEqual(platform.template.passJson);
    expect(r.assets).toEqual(storedAssets(platform));
    expect((await registry().resolve('baked:starter', platform.template.version)).version).toBe(
      platform.template.version,
    );
  });

  it('gives a baked org template its org id', async () => {
    expect((await registry().resolve('baked:acme-card')).orgId).toBe(org.id);
  });

  it('resolves approved stored metadata and bytes when generated content changes or disappears', async () => {
    const files = basicPackage({ 'logo.png': makePng(100, 40) });
    const fixture = serve(await bakedFrom('approved-storage', files, { name: 'Approved Storage' }));
    const source = sourceOf([fixture], 'reg-approved-storage');
    await syncBakedTemplates(ctx(), source);
    const contentHash = await templateContentHash(ctx(), {
      manifest: fixture.template.manifest,
      passJson: fixture.template.passJson,
      assets: storedAssets(fixture),
    });
    const releaseRows = () =>
      all<{
        mode: string;
        org_id: string | null;
        version: string;
        generation: number;
        content_hash: string;
        source: string;
        action: string;
      }>(
        env.DB,
        'SELECT mode, org_id, version, generation, content_hash, source, action FROM template_releases WHERE template_id = ? ORDER BY mode',
        [fixture.template.id],
      );
    const approved = await releaseRows();
    expect(approved).toEqual([
      {
        mode: 'live',
        org_id: null,
        version: fixture.template.version,
        generation: 1,
        content_hash: contentHash,
        source: 'system',
        action: 'system',
      },
      {
        mode: 'test',
        org_id: null,
        version: fixture.template.version,
        generation: 1,
        content_hash: contentHash,
        source: 'system',
        action: 'system',
      },
    ]);

    const icon = fixture.template.assets.find((asset) => asset.name === 'icon.png');
    if (!icon) throw new Error('Expected a generated icon');
    const approvedBytes = fixture.files.get(icon.source.path);
    if (!approvedBytes) throw new Error('Expected the original icon bytes');
    const changedBytes = makePng(39, 39);
    expect(changedBytes).not.toEqual(approvedBytes);
    const changedSource = {
      ...source,
      templates: [
        {
          ...fixture.template,
          manifest: { ...fixture.template.manifest, name: 'Untrusted generated name' },
          passJson: {
            ...fixture.template.passJson,
            description: 'Untrusted generated description',
          },
        },
      ],
    };
    const reg = registry(changedSource);
    assets.files.set(icon.source.path, changedBytes);
    for (const state of ['changed', 'missing'] as const) {
      if (state === 'missing') assets.files.delete(icon.source.path);
      expect(assets.files.get(icon.source.path)).toEqual(
        state === 'changed' ? changedBytes : undefined,
      );
      // Force a fresh sync and D1 resolution rather than using either isolate cache.
      resetBakedSync();
      clearTemplateCache(env, fixture.template.id);
      const resolved = await reg.resolve(fixture.template.id, fixture.template.version);
      expect(resolved.manifest).toEqual(fixture.template.manifest);
      expect(resolved.passJson).toEqual(fixture.template.passJson);
      expect(resolved.assets).toEqual(storedAssets(fixture));
      const iconBytes = new Uint8Array(
        await new Response(await reg.openAsset(resolved, 'icon.png')).arrayBuffer(),
      );
      const logoBytes = new Uint8Array(
        await new Response(await reg.openAsset(resolved, 'logo.png')).arrayBuffer(),
      );
      expect(iconBytes).toEqual(approvedBytes);
      expect(logoBytes).toEqual(files.get('logo.png'));
      expect(await templateContentHash(ctx(), resolved)).toBe(contentHash);
      expect(await releaseRows()).toEqual(approved);
    }
  });

  it('does not approve missing baked bytes and retries the incomplete sync when they return', async () => {
    const fixture = serve(await bakedFrom('missing-storage', basicPackage(), { name: 'Missing' }));
    const icon = fixture.template.assets.find((asset) => asset.name === 'icon.png');
    if (!icon) throw new Error('Expected a generated icon');
    const bytes = fixture.files.get(icon.source.path);
    if (!bytes) throw new Error('Expected the original icon bytes');
    assets.files.delete(icon.source.path);
    const reg = registry(sourceOf([fixture], 'reg-missing-storage'));
    const unresolved = await reg.resolve(fixture.template.id);
    expect(unresolved.assets).toEqual(storedAssets(fixture));
    const missingReleases = await all(
      env.DB,
      'SELECT id FROM template_releases WHERE template_id = ?',
      [fixture.template.id],
    );
    expect(missingReleases).toEqual([]);
    await expect(reg.openAsset(unresolved, 'icon.png')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });

    assets.files.set(icon.source.path, bytes);
    clearTemplateCache(env, fixture.template.id);
    const repaired = await reg.resolve(fixture.template.id);
    expect(repaired.assets).toEqual(storedAssets(fixture));
    const repairedBytes = new Uint8Array(
      await new Response(await reg.openAsset(repaired, 'icon.png')).arrayBuffer(),
    );
    expect(repairedBytes).toEqual(bytes);
    const repairedReleases = await all<{
      mode: string;
      version: string;
      generation: number;
      source: string;
    }>(
      env.DB,
      'SELECT mode, version, generation, source FROM template_releases WHERE template_id = ? ORDER BY mode',
      [fixture.template.id],
    );
    expect(repairedReleases).toEqual([
      { mode: 'live', version: fixture.template.version, generation: 1, source: 'system' },
      { mode: 'test', version: fixture.template.version, generation: 1, source: 'system' },
    ]);
  });

  it('opens baked bundle assets from R2 and fails closed when an object is missing', async () => {
    const reg = registry();
    const r = await reg.resolve('baked:starter');
    expect(r.assets).toEqual(storedAssets(platform));
    for (const asset of platform.template.assets) {
      const bytes = new Uint8Array(
        await new Response(await reg.openAsset(r, asset.name)).arrayBuffer(),
      );
      expect(bytes).toEqual(platform.files.get(asset.source.path));
    }
    await expect(reg.openAsset(r, 'nope.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const icon = r.assets.find((asset) => asset.name === 'icon.png');
    const staticIcon = platform.template.assets.find((asset) => asset.name === 'icon.png');
    if (icon?.source.kind !== 'r2' || !staticIcon) throw new Error('Expected an icon');
    const original = await env.BUCKET.get(icon.source.key);
    if (!original) throw new Error('Expected the synced R2 icon');
    const bytes = await original.arrayBuffer();
    await env.BUCKET.delete(icon.source.key);
    try {
      expect(assets.files.has(staticIcon.source.path)).toBe(true);
      await expect(reg.openAsset(r, 'icon.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    } finally {
      await env.BUCKET.put(icon.source.key, bytes);
    }
  });

  it('does not approve the SPA fallback as a baked bundle asset', async () => {
    const fixture = serve(await bakedFrom('spa-bundle', basicPackage(), { name: 'SPA Bundle' }));
    const icon = fixture.template.assets.find((asset) => asset.name === 'icon.png');
    if (!icon) throw new Error('Expected a generated icon');
    const spa: AppEnv = {
      ...env,
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === icon.source.path)
            return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
          return assets.fetch(input);
        },
      } as unknown as Fetcher,
    };
    const reg = createTemplateRegistry(spa, {
      source: sourceOf([fixture], 'reg-spa-bundle'),
      ctx: createServiceContext(spa, { clock }),
    });
    const unresolved = await reg.resolve(fixture.template.id);
    expect(unresolved.assets).toEqual(storedAssets(fixture));
    expect(
      await all(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [
        fixture.template.id,
      ]),
    ).toEqual([]);
    await expect(reg.openAsset(unresolved, 'icon.png')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });

  it('does not seal an SPA fallback as an extra and recovers when valid bytes return', async () => {
    const files = basicPackage({ 'strip.png': makePng(375, 144) });
    const fixture = serve(await bakedFrom('spa-extra', files, { name: 'SPA Extra' }));
    const extra = fixture.template.extras.find((entry) => entry.name === 'strip.png');
    if (!extra) throw new Error('Expected a static extra');
    let fallback = true;
    const spa: AppEnv = {
      ...env,
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (fallback && url.pathname === extra.path)
            return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
          return assets.fetch(input);
        },
      } as unknown as Fetcher,
    };
    const reg = createTemplateRegistry(spa, {
      source: sourceOf([fixture], 'reg-spa-extra'),
      ctx: createServiceContext(spa, { clock }),
    });
    const r = await reg.resolve(fixture.template.id);
    expect(r.assets).toEqual(storedAssets(fixture));
    const iconBytes = new Uint8Array(
      await new Response(await reg.openAsset(r, 'icon.png')).arrayBuffer(),
    );
    expect(iconBytes).toEqual(files.get('icon.png'));
    expect(
      await all(env.DB, 'SELECT id FROM template_releases WHERE template_id = ?', [
        fixture.template.id,
      ]),
    ).toEqual([]);
    await expect(reg.openExtra(r, 'strip.png')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
      status: 404,
    });

    fallback = false;
    clearTemplateCache(env, fixture.template.id);
    const repaired = await reg.resolve(fixture.template.id);
    const extraBytes = new Uint8Array(
      await new Response(await reg.openExtra(repaired, 'strip.png')).arrayBuffer(),
    );
    expect(extraBytes).toEqual(files.get('strip.png'));
    expect(
      await all<{ mode: string; version: string; source: string }>(
        env.DB,
        'SELECT mode, version, source FROM template_releases WHERE template_id = ? ORDER BY mode',
        [fixture.template.id],
      ),
    ).toEqual([
      { mode: 'live', version: fixture.template.version, source: 'system' },
      { mode: 'test', version: fixture.template.version, source: 'system' },
    ]);
  });

  it('serves baked extras that are not in the bundle', async () => {
    const files = basicPackage({ 'strip.png': makePng(375, 144) });
    const withExtra = serve(await bakedFrom('extra', files, { name: 'Extra' }));
    const reg = registry(sourceOf([withExtra], 'reg-extra'));
    const r = await reg.resolve('baked:extra');
    expect(r.assets.map((a) => a.name)).not.toContain('strip.png');
    const bytes = new Uint8Array(
      await new Response(await reg.openExtra(r, 'strip.png')).arrayBuffer(),
    );
    expect(bytes).toEqual(files.get('strip.png'));
    await expect(reg.openExtra(r, 'other.png')).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('maps a tampered or unsealed baked extra to a 404 instead of a server error', async () => {
    const files = basicPackage({ 'strip.png': makePng(375, 144) });
    const withExtra = serve(await bakedFrom('extra-4xx', files, { name: 'Extra 4xx' }));
    const reg = registry(sourceOf([withExtra], 'reg-extra-4xx'));
    const resolved = await reg.resolve('baked:extra-4xx');
    const key = bakedExtraR2Key(withExtra.template.id, withExtra.template.version, 'strip.png');
    const original = await (await env.BUCKET.get(key))?.arrayBuffer();
    if (!original) throw new Error('Expected the sealed extra in R2');
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3]));
    try {
      await expect(reg.openExtra(resolved, 'strip.png')).rejects.toMatchObject({
        code: 'ASSET_NOT_FOUND',
        status: 404,
      });
    } finally {
      await env.BUCKET.put(key, original);
    }
    await run(env.DB, 'DROP TRIGGER template_version_extra_sets_no_delete');
    await run(env.DB, 'DELETE FROM template_version_extra_sets WHERE template_id = ?', [
      withExtra.template.id,
    ]);
    await expect(reg.openExtra(resolved, 'strip.png')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
      status: 404,
    });
  });

  it('opens sealed historical extras from R2 after generated files change or disappear', async () => {
    const oldFiles = basicPackage({ 'strip.png': makePng(375, 144) });
    const newFiles = basicPackage({ 'strip.png': makePng(375, 123) });
    const oldBytes = oldFiles.get('strip.png');
    const newBytes = newFiles.get('strip.png');
    if (!oldBytes || !newBytes) throw new Error('Expected both preview images');
    expect(oldBytes).not.toEqual(newBytes);
    const old = serve(await bakedFrom('pinned-extra', oldFiles, { name: 'Pinned Extra' }));
    const oldExtra = old.template.extras.find((extra) => extra.name === 'strip.png');
    if (!oldExtra) throw new Error('Expected the old generated extra');
    await syncBakedTemplates(ctx(), sourceOf([old], 'reg-extra-v1'));
    const savedOldExtras = await listVersionExtras(env.DB, old.template.id, old.template.version);
    const oldKey = bakedExtraR2Key(old.template.id, old.template.version, 'strip.png');
    expect(savedOldExtras).toEqual([
      {
        name: 'strip.png',
        size: oldBytes.length,
        sha1: oldExtra.sha1.toLowerCase(),
        sha256: await sha256Hex(oldBytes),
        r2Key: oldKey,
      },
    ]);
    const oldHash = await templateContentHash(
      ctx(),
      {
        manifest: old.template.manifest,
        passJson: old.template.passJson,
        assets: storedAssets(old),
      },
      savedOldExtras,
    );

    const next = serve(await bakedFrom('pinned-extra', newFiles, { name: 'Pinned Extra' }));
    expect(next.template.version).not.toBe(old.template.version);
    advanceBuild();
    const nextSource = sourceOf([next], 'reg-extra-v2');
    await syncBakedTemplates(ctx(), nextSource);
    const savedNewExtras = await listVersionExtras(env.DB, next.template.id, next.template.version);
    const newHash = await templateContentHash(
      ctx(),
      {
        manifest: next.template.manifest,
        passJson: next.template.passJson,
        assets: storedAssets(next),
      },
      savedNewExtras,
    );
    expect(newHash).not.toBe(oldHash);
    const releases = await all<{
      mode: string;
      version: string;
      generation: number;
      content_hash: string;
      source: string;
    }>(
      env.DB,
      'SELECT mode, version, generation, content_hash, source FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
      [old.template.id],
    );
    expect(releases).toEqual([
      {
        mode: 'live',
        version: old.template.version,
        generation: 1,
        content_hash: oldHash,
        source: 'system',
      },
      {
        mode: 'live',
        version: next.template.version,
        generation: 2,
        content_hash: newHash,
        source: 'system',
      },
      {
        mode: 'test',
        version: old.template.version,
        generation: 1,
        content_hash: oldHash,
        source: 'system',
      },
      {
        mode: 'test',
        version: next.template.version,
        generation: 2,
        content_hash: newHash,
        source: 'system',
      },
    ]);

    const reg = registry(nextSource);
    assets.files.set(oldExtra.path, newBytes);
    for (const state of ['changed', 'missing'] as const) {
      if (state === 'missing') assets.files.delete(oldExtra.path);
      expect(assets.files.get(oldExtra.path)).toEqual(state === 'changed' ? newBytes : undefined);
      resetBakedSync();
      clearTemplateCache(env, old.template.id);
      const pinned = await reg.resolve(old.template.id, old.template.version);
      const current = await reg.resolve(next.template.id);
      expect(current.version).toBe(next.template.version);
      expect(pinned.assets.map((asset) => asset.name)).not.toContain('strip.png');
      const historicalBytes = new Uint8Array(
        await new Response(await reg.openExtra(pinned, 'strip.png')).arrayBuffer(),
      );
      const currentBytes = new Uint8Array(
        await new Response(await reg.openExtra(current, 'strip.png')).arrayBuffer(),
      );
      expect(historicalBytes).toEqual(oldBytes);
      expect(currentBytes).toEqual(newBytes);
      expect(await listVersionExtras(env.DB, old.template.id, old.template.version)).toEqual(
        savedOldExtras,
      );
    }
    const after = await all(
      env.DB,
      'SELECT mode, version, generation, content_hash, source FROM template_releases WHERE template_id = ? ORDER BY mode, generation',
      [old.template.id],
    );
    expect(after).toEqual(releases);

    const pinned = await reg.resolve(old.template.id, old.template.version);
    assets.files.set(oldExtra.path, oldBytes);
    await env.BUCKET.delete(oldKey);
    try {
      await expect(reg.openExtra(pinned, 'strip.png')).rejects.toMatchObject({
        code: 'ASSET_NOT_FOUND',
        status: 404,
      });
      const tampered = oldBytes.slice();
      tampered[0] = (tampered[0] ?? 0) ^ 1;
      await env.BUCKET.put(oldKey, tampered);
      await expect(reg.openExtra(pinned, 'strip.png')).rejects.toMatchObject({
        code: 'ASSET_NOT_FOUND',
        status: 404,
      });
    } finally {
      await env.BUCKET.put(oldKey, oldBytes);
    }
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

  it('keeps uploaded drafts inactive but resolves their explicit versions and assets', async () => {
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
    expect(a.result).not.toBeNull();
    expect(b.result).not.toBeNull();
    const id = a.result?.templateId ?? '';
    expect(b.result?.templateId).toBe(id);
    expect(b.result?.version).not.toBe(a.result?.version);
    const row = await first<{ active_version: string | null }>(
      env.DB,
      'SELECT active_version FROM templates WHERE id = ?',
      [id],
    );
    expect(row?.active_version).toBeNull();
    const reg = registry();
    await expect(reg.resolve(id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      status: 404,
    });
    const firstDraft = await reg.resolve(id, a.result?.version);
    expect(firstDraft).toMatchObject({
      origin: 'uploaded',
      orgId: org.id,
      version: a.result?.version,
    });
    expect(firstDraft.assets.map((x) => x.name)).toEqual(['icon.png', 'icon@2x.png']);
    expect((await reg.resolve(id, b.result?.version)).assets.map((x) => x.name)).toContain(
      'logo.png',
    );
    const bytes = new Uint8Array(
      await new Response(await reg.openAsset(firstDraft, 'icon.png')).arrayBuffer(),
    );
    expect(bytes).toEqual(basicPackage().get('icon.png'));
    await expect(reg.resolve(id)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      status: 404,
    });
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

  it('refreshes a cached resolution when the template moved to another org', async () => {
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Moved',
    });
    const id = a.result?.templateId ?? '';
    const other = await makeOrg(fixtures(env, clock), { slug: 'moved-to', name: 'Moved to' });
    const reg = registry();
    const before = await reg.resolve(id, a.result?.version);
    expect(before.orgId).toBe(org.id);
    await run(env.DB, 'UPDATE templates SET org_id = ? WHERE id = ?', [other.id, id]);
    const after = await reg.resolve(id, a.result?.version);
    expect(after.orgId).toBe(other.id);
    expect(after).not.toBe(before);
    expect(await reg.resolve(id, a.result?.version)).toBe(after);
  });

  it('keeps formerly published archived templates resolvable for existing passes, but not deleted ones', async () => {
    const a = await importZip(env, clock, {
      orgId: org.id,
      zip: zipOf(basicPackage()),
      name: 'Archived',
    });
    expect(a.result).not.toBeNull();
    const id = a.result?.templateId ?? '';
    const version = a.result?.version ?? '';
    // Simulate a version published before the separate release-approval requirement existed.
    await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [version, id]);
    await run(env.DB, "UPDATE templates SET status = 'archived' WHERE id = ?", [id]);
    expect((await registry().resolve(id)).version).toBe(version);
    expect((await registry().resolve(id, version)).id).toBe(id);
    clearTemplateCache(env, id);
    await run(env.DB, "UPDATE templates SET status = 'deleted' WHERE id = ?", [id]);
    await expect(registry().resolve(id)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    await expect(registry().resolve(id, version)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    });
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
    const mineAndPlatform = await reg.list({ orgId: org.id });
    const ids = mineAndPlatform.map((t) => t.id);
    expect(ids).toContain(mine.result?.templateId);
    expect(mineAndPlatform.find((t) => t.id === mine.result?.templateId)?.activeVersion).toBeNull();
    expect(ids).toContain('baked:starter');
    expect(ids).toContain('baked:acme-card');
    expect(ids).not.toContain(theirs.result?.templateId);
    expect((await reg.list({ orgId: null })).every((t) => t.orgId === null)).toBe(true);
    const otherIds = (await reg.list({ orgId: other.id })).map((t) => t.id);
    expect(otherIds).toContain(theirs.result?.templateId);
    expect(otherIds).toContain('baked:starter');
    expect(otherIds).not.toContain(mine.result?.templateId);
    expect(otherIds).not.toContain('baked:acme-card');
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

  it('builds and signs an existing pass from a previously published uploaded template', async () => {
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
    expect(a.result).not.toBeNull();
    const id = a.result?.templateId ?? '';
    // Simulate a version published before the separate release-approval requirement existed.
    await run(env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
      a.result?.version ?? '',
      id,
    ]);
    const reg = registry();
    const template = await reg.resolve(id);
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
      'icon@2x.png',
      'manifest.json',
      'pass.json',
      'signature',
    ]);
    expect(built.passJson.generic?.primaryFields?.[0]?.value).toBe('Sam Rivera');
  });
});
