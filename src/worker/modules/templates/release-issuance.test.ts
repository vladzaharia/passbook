import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { cachedAssetBytes } from '../../../passkit/asset-cache.ts';
import { crc32 } from '../../../passkit/index.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { all, first, run } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import {
  approveAppleRelease,
  createAppleReleaseCandidate,
} from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG, type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { basicPackage } from './package/fixtures.ts';
import { buildKey, sha1Hex } from './package/hash.ts';
import { createTemplateRegistry } from './registry.ts';
import { activeRelease } from './releases.ts';
import { effectiveReleaseIdSql } from './repo-release-heads.ts';
import { insertVersionHashesStmt } from './repo-version-hashes.ts';
import { resetBakedSync, syncBakedTemplates } from './sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from './testing.ts';

let kit: Kit;
const assets = fakeAssets();
let sequence = 0;

beforeAll(async () => {
  kit = await setupKit({ approvedReleases: false });
  kit.env.ASSETS = assets;
});

async function version(id: string, v: string) {
  const manifest = structuredClone(kit.template.manifest) as TemplateManifest;
  const pass = structuredClone(kit.template.passJson) as PassJson;
  const key = `templates/${kit.org.id}/${id}/${v}/icon.png`;
  await kit.env.BUCKET.put(key, ICON_PNG);
  const entry = {
    name: 'icon.png',
    slot: 'icon',
    scale: 1,
    size: ICON_PNG.length,
    sha1: await sha1Hex(ICON_PNG),
    crc32: crc32(ICON_PNG),
    width: 38,
    height: 38,
    source: { kind: 'r2', key },
  };
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT OR IGNORE INTO templates (id, org_id, slug, name, origin, active_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'uploaded', ?, ?, ?)`,
    [id, kit.org.id, id, manifest.name, v, now, now],
  );
  await run(
    kit.env.DB,
    `INSERT INTO template_versions (template_id, version, manifest, pass_json, assets, build_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      v,
      JSON.stringify(manifest),
      JSON.stringify(pass),
      JSON.stringify([entry]),
      await buildKey({ manifest, passJson: pass, assets: [entry] }),
      now,
    ],
  );
  return { key, size: ICON_PNG.length };
}

const issuing = (id: string, ctx: ServiceContext = kit.ctx) =>
  activeRelease(ctx, id, kit.org.id, 'live', 'apple');
const hashRow = (id: string, v: string) =>
  first<{ content_hash: string; asset_hashes: string }>(
    kit.env.DB,
    'SELECT content_hash, asset_hashes FROM template_version_hashes WHERE template_id = ? AND version = ?',
    [id, v],
  );

/** Wrap the bucket so the test can count body reads and size probes. */
function countingBucket() {
  const real = kit.env.BUCKET;
  const calls = { get: 0, head: 0 };
  const bucket = {
    get: (key: string) => {
      calls.get += 1;
      return real.get(key);
    },
    head: (key: string) => {
      calls.head += 1;
      return real.head(key);
    },
  } as unknown as R2Bucket;
  return { calls, ctx: { ...kit.ctx, env: { ...kit.env, BUCKET: bucket } } as ServiceContext };
}

describe('per-version content hashes', () => {
  it('are written at candidate creation with each asset sha256, and issuance reads no asset bytes', async () => {
    const id = `tpl-hash-issue-${sequence++}`;
    await version(id, 'v1');
    expect(await hashRow(id, 'v1')).toBeNull();
    const release = await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    const saved = await hashRow(id, 'v1');
    expect(saved?.content_hash).toBe(
      (
        await first<{ content_hash: string }>(
          kit.env.DB,
          'SELECT content_hash FROM template_releases WHERE id = ?',
          [release.id],
        )
      )?.content_hash,
    );
    expect(JSON.parse(saved?.asset_hashes ?? '[]')).toEqual([
      { name: 'icon.png', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    const { calls, ctx } = countingBucket();
    expect(await issuing(id, ctx)).toMatchObject({ id: release.id });
    expect(calls.get).toBe(0);
    expect(calls.head).toBeGreaterThan(0);
  });

  it('a second candidate for the same version reuses the saved hashes', async () => {
    const id = `tpl-hash-reuse-${sequence++}`;
    await version(id, 'v1');
    await approveAppleRelease(kit, { templateId: id, version: 'v1', mode: 'live' });
    const first1 = await hashRow(id, 'v1');
    await approveAppleRelease(kit, { templateId: id, version: 'v1', mode: 'test' });
    expect(await hashRow(id, 'v1')).toEqual(first1);
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM template_version_hashes WHERE template_id = ?', [id]),
    ).toHaveLength(1);
  });

  it('refuse an update, a delete and a replacement', async () => {
    const id = `tpl-hash-guard-${sequence++}`;
    await version(id, 'v1');
    await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    const saved = await hashRow(id, 'v1');
    const other = 'f'.repeat(64);
    await expect(
      run(kit.env.DB, 'UPDATE template_version_hashes SET content_hash = ? WHERE template_id = ?', [
        other,
        id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(kit.env.DB, 'DELETE FROM template_version_hashes WHERE template_id = ?', [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO template_version_hashes (template_id, version, content_hash, asset_hashes, created_at)
         VALUES (?, 'v1', ?, '[]', 1)`,
        [id, other],
      ),
    ).rejects.toThrow(/UNIQUE/);
    expect(await hashRow(id, 'v1')).toEqual(saved);
  });

  it('changed content still refuses issuance with TEMPLATE_CONTENT_CHANGED', async () => {
    const id = `tpl-hash-tamper-${sequence++}`;
    const { key, size } = await version(id, 'v1');
    const release = await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    expect(await issuing(id)).toMatchObject({ id: release.id });

    // A stored object whose size changed.
    await kit.env.BUCKET.put(key, new Uint8Array(size + 1));
    try {
      await expect(issuing(id)).rejects.toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
    } finally {
      await kit.env.BUCKET.put(key, ICON_PNG);
    }
    expect(await issuing(id)).toMatchObject({ id: release.id });

    // A stored document edited after release (the immutability trigger is dropped to simulate it).
    await withoutTrigger(kit.env.DB, 'template_versions_immutable', async () => {
      await run(
        kit.env.DB,
        `UPDATE template_versions SET pass_json = json_set(pass_json, '$.description', 'tampered')
         WHERE template_id = ? AND version = 'v1'`,
        [id],
      );
      await expect(issuing(id)).rejects.toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
    });
  });

  it('a same-size swap with a saved hash is refused when the asset is opened, and nothing is cached', async () => {
    const id = `tpl-hash-swap-${sequence++}`;
    const { key, size } = await version(id, 'v1');
    const release = await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    expect(await hashRow(id, 'v1')).not.toBeNull();
    const registry = createTemplateRegistry(kit.env, { ctx: kit.ctx });
    const template = await registry.resolve(id, 'v1');
    const entry = template.assets[0];
    if (!entry) throw new Error('Missing asset');
    const load = async () => {
      const reader = (await registry.openAsset(template, entry.name)).getReader();
      const chunks: Uint8Array[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
      return Uint8Array.from(chunks.flatMap((c) => [...c]));
    };
    await kit.env.BUCKET.put(key, new Uint8Array(size).fill(7));
    try {
      // Issuance sees the same hash row and size, so only the byte check can refuse it.
      expect(await issuing(id)).toMatchObject({ id: release.id });
      await expect(cachedAssetBytes(id, 'v1', entry, load)).rejects.toMatchObject({
        code: 'TEMPLATE_CONTENT_CHANGED',
      });
    } finally {
      await kit.env.BUCKET.put(key, ICON_PNG);
    }
    expect(await cachedAssetBytes(id, 'v1', entry, load)).toEqual(ICON_PNG);
  });

  it('a refused candidate leaves no hash row', async () => {
    const other = `tpl-hash-refused-b-${sequence++}`;
    await version(other, 'v1');
    const stmt = insertVersionHashesStmt(
      kit.env.DB,
      other,
      'v1',
      { contentHash: 'c'.repeat(64), assetHashes: [] },
      1,
      'no-such-candidate',
    );
    await stmt.run();
    expect(await hashRow(other, 'v1')).toBeNull();
  });

  it('a version with no saved hash still refuses changed bytes', async () => {
    const id = `tpl-hash-unsaved-${sequence++}`;
    const { key, size } = await version(id, 'v1');
    await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    await withoutTrigger(kit.env.DB, 'template_version_hashes_no_delete', async () => {
      await run(kit.env.DB, 'DELETE FROM template_version_hashes WHERE template_id = ?', [id]);
    });
    // Same size, different bytes: only the byte-level check can see it.
    const swapped = new Uint8Array(size).fill(7);
    await kit.env.BUCKET.put(key, swapped);
    try {
      await expect(issuing(id)).rejects.toMatchObject({ code: 'TEMPLATE_CONTENT_CHANGED' });
      expect(await hashRow(id, 'v1')).toBeNull();
    } finally {
      await kit.env.BUCKET.put(key, ICON_PNG);
    }
  });

  it('a release whose version hash differs is not effective, a missing one is saved, and a legacy one is exempt', async () => {
    const id = `tpl-hash-sql-${sequence++}`;
    await version(id, 'v1');
    const release = await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    const saved = await hashRow(id, 'v1');
    await withoutTrigger(kit.env.DB, 'template_version_hashes_immutable', async () => {
      await run(
        kit.env.DB,
        'UPDATE template_version_hashes SET content_hash = ? WHERE template_id = ?',
        ['e'.repeat(64), id],
      );
      expect(await issuing(id)).toBeNull();
      await run(
        kit.env.DB,
        'UPDATE template_version_hashes SET content_hash = ? WHERE template_id = ?',
        [saved?.content_hash, id],
      );
    });
    expect(await issuing(id)).toMatchObject({ id: release.id });
    // A version with no saved hash (released before hashes existed) is verified from its bytes, then saved.
    await withoutTrigger(kit.env.DB, 'template_version_hashes_no_delete', async () => {
      await run(kit.env.DB, 'DELETE FROM template_version_hashes WHERE template_id = ?', [id]);
    });
    const { calls, ctx } = countingBucket();
    expect(await issuing(id, ctx)).toMatchObject({ id: release.id });
    expect(calls.get).toBeGreaterThan(0);
    expect(await hashRow(id, 'v1')).toEqual(saved);
    expect(await issuing(id)).toMatchObject({ id: release.id });

    const legacyId = `tpl-hash-legacy-${sequence++}`;
    await version(legacyId, 'v1');
    await run(
      kit.env.DB,
      `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
         candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
         source, action, created_at)
       VALUES (?, ?, ?, 'live', 'apple', 1, 'v1', ?, ?, 1, '["apple-passkit"]', 1, 'legacy', 'legacy', 1)`,
      [kit.fx.ids.id(), legacyId, kit.org.id, 'a'.repeat(64), 'b'.repeat(64)],
    );
    expect(await hashRow(legacyId, 'v1')).toBeNull();
    expect(await issuing(legacyId)).toMatchObject({ source: 'legacy', generation: 1 });
  });
});

describe('baked sync', () => {
  it('saves the hashes, and the platform release is effective for any org', async () => {
    const slug = `hash-baked-${sequence++}`;
    const fixture = await bakedFrom(
      slug,
      basicPackage({ 'wallet.template.json': JSON.stringify(kit.template.manifest) }),
    );
    for (const [path, bytes] of fixture.files) assets.files.set(path, bytes);
    resetBakedSync();
    const worker = {
      ...kit.env,
      CF_VERSION: {
        id: `hash-${slug}`,
        tag: '',
        timestamp: new Date(Date.UTC(2041, 0, 1)).toISOString(),
      },
    };
    await syncBakedTemplates(
      createServiceContext(worker, { clock: kit.clock }),
      sourceOf([fixture], `${slug}-1`),
    );
    const id = fixture.template.id;
    const v = fixture.template.version;
    const release = await first<{ id: string; content_hash: string }>(
      kit.env.DB,
      "SELECT id, content_hash FROM template_releases WHERE template_id = ? AND mode = 'live' AND org_id IS NULL",
      [id],
    );
    expect((await hashRow(id, v))?.content_hash).toBe(release?.content_hash);
    expect(await issuing(id)).toMatchObject({ id: release?.id, orgId: null });
  });
});

const REFUSED = /stale template release|invalid template release|CHECK constraint|UNIQUE/;
const insertRelease = (values: {
  id?: string;
  templateId: string;
  orgId: string | null;
  mode?: string;
  generation?: number;
  source: 'legacy' | 'approved';
  candidateId?: string | null;
  previous?: string | null;
}) =>
  run(
    kit.env.DB,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
       candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
       source, action, candidate_id, previous_release_id, created_by, created_at)
     VALUES (?, ?, ?, ?, 'apple', ?, 'v1', ?, ?, 1, '["apple-passkit"]', 1, ?, ?, ?, ?, ?, 1)`,
    [
      values.id ?? kit.fx.ids.id(),
      values.templateId,
      values.orgId,
      values.mode ?? 'live',
      values.generation ?? 1,
      'a'.repeat(64),
      'b'.repeat(64),
      values.source,
      values.source === 'legacy' ? 'legacy' : 'release',
      values.candidateId ?? null,
      values.previous ?? null,
      values.source === 'legacy' ? null : 'someone',
    ],
  );

describe('release heads and legacy releases', () => {
  it("a legacy release issues only while it is the scope's only release", async () => {
    const id = `tpl-head-legacy-${sequence++}`;
    await version(id, 'v1');
    const legacyId = kit.fx.ids.id();
    await insertRelease({ id: legacyId, templateId: id, orgId: kit.org.id, source: 'legacy' });
    expect(await issuing(id)).toMatchObject({ id: legacyId, source: 'legacy' });
    // Another mode is a different scope with no release.
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'test', 'apple')).toBeNull();
    // A second legacy row cannot join a scope that has a release.
    await expect(
      insertRelease({ templateId: id, orgId: kit.org.id, source: 'legacy' }),
    ).rejects.toThrow(REFUSED);
    const approved = await approveAppleRelease(kit, { templateId: id, version: 'v1' });
    expect(await issuing(id)).toMatchObject({ id: approved.id, source: 'approved' });
    await expect(
      insertRelease({ templateId: id, orgId: kit.org.id, source: 'legacy', generation: 3 }),
    ).rejects.toThrow(REFUSED);
    expect(await issuing(id)).toMatchObject({ id: approved.id });
  });

  it('a legacy release stops issuing when the active version moves away from it', async () => {
    const id = `tpl-head-moved-${sequence++}`;
    await version(id, 'v1');
    await insertRelease({ templateId: id, orgId: kit.org.id, source: 'legacy' });
    expect(await issuing(id)).not.toBeNull();
    await run(kit.env.DB, "UPDATE templates SET active_version = 'v2' WHERE id = ?", [id]);
    expect(await issuing(id)).toBeNull();
  });

  it('an unapproved or foreign-org release is refused and the head does not move', async () => {
    const id = `tpl-head-refused-${sequence++}`;
    await version(id, 'v1');
    const legacyId = kit.fx.ids.id();
    await insertRelease({ id: legacyId, templateId: id, orgId: kit.org.id, source: 'legacy' });
    const { candidate } = await createAppleReleaseCandidate(kit, { templateId: id, version: 'v1' });
    // No candidate, and a candidate with no approval.
    await expect(
      insertRelease({
        templateId: id,
        orgId: kit.org.id,
        source: 'approved',
        generation: 2,
        previous: legacyId,
      }),
    ).rejects.toThrow(REFUSED);
    await expect(
      insertRelease({
        templateId: id,
        orgId: kit.org.id,
        source: 'approved',
        generation: 2,
        previous: legacyId,
        candidateId: candidate.id,
      }),
    ).rejects.toThrow(REFUSED);
    // A release for another organization on this organization's template.
    const other = await makeOrg(kit.fx, { name: 'Foreign org' });
    await expect(
      insertRelease({
        templateId: id,
        orgId: other.id,
        source: 'approved',
        candidateId: candidate.id,
      }),
    ).rejects.toThrow(REFUSED);
    expect(
      await all(kit.env.DB, 'SELECT release_id FROM template_release_heads WHERE template_id = ?', [
        id,
      ]),
    ).toEqual([{ release_id: legacyId }]);
    expect(await issuing(id)).toMatchObject({ id: legacyId });
  });
});

describe('head lookup plan', () => {
  it('uses the full template_releases_head prefix, org included', async () => {
    const plan = await all<{ detail: string }>(
      kit.env.DB,
      `EXPLAIN QUERY PLAN SELECT (${effectiveReleaseIdSql({
        templateIdSql: "'t'",
        orgIdSql: "'o'",
        modeSql: "'live'",
        providerSql: "'apple'",
      })})`,
    );
    expect(
      plan.some((r) =>
        /template_releases_head \(template_id=\? AND mode=\? AND provider=\? AND org_id=\?\)/.test(
          r.detail,
        ),
      ),
    ).toBe(true);
  });
});
