import { describe, expect, it } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { basicPackage, makePng } from '../templates/package/fixtures.ts';
import { createTemplateRegistry } from '../templates/registry.ts';
import { generatedSource, resetBakedSync, syncBakedTemplates } from '../templates/sync.ts';
import { bakedFrom, fakeAssets, sourceOf } from '../templates/testing.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import {
  type LiveTemplateBinding,
  liveTemplateSnapshotFromResult,
  liveTemplateSnapshotStmt,
} from './repo-live-template-snapshot.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

interface Projected {
  passId: string;
  orgId: string;
  mode: 'live' | 'test';
  templateId: string;
  pinnedVersion: string;
  issuedId: string | null;
  pinned: { version: string; buildKey: string | null } | null;
  active: { version: string; buildKey: string | null } | null;
  release: { id: string; generation: number; version: string; candidateHash: string } | null;
}

async function capture(kit: ScanKit, passId: string, mode: 'live' | 'test' = 'live') {
  const result = await liveTemplateSnapshotStmt(kit.env.DB, kit.org.id, mode, passId).all();
  const snapshot = liveTemplateSnapshotFromResult(result);
  if (!snapshot) throw new Error('Expected a template snapshot');
  const data = JSON.parse(snapshot.raw) as Projected;
  const compatible =
    data.pinned &&
    data.active &&
    (data.pinned.version === data.active.version ||
      (data.pinned.buildKey !== null && data.pinned.buildKey === data.active.buildKey));
  const binding: LiveTemplateBinding = {
    pass: {
      id: data.passId,
      orgId: data.orgId,
      mode: data.mode,
      templateId: data.templateId,
      templateVersion: data.pinnedVersion,
      releaseId: data.issuedId,
    },
    activeReleaseId: data.release?.id ?? null,
    activeReleaseGeneration: data.release?.generation ?? null,
    activeReleaseVersion: data.release?.version ?? null,
    activeReleaseCandidateHash: data.release?.candidateHash ?? null,
    activeTemplateVersion: data.active?.version ?? null,
    displayTemplateVersion: compatible ? data.active!.version : null,
  };
  return { binding, snapshot, data };
}

describe('live template snapshot baked assets', () => {
  it('resolves baked versions from their stored R2 assets and verifies their sealed extras', async () => {
    const kit = await setupScanKit();
    const assets = fakeAssets();
    Object.assign(kit.env, { ASSETS: assets });
    const baked = await bakedFrom(
      `snapshot-${kit.fx.ids.token(5)}`,
      basicPackage({
        'wallet.template.json': JSON.stringify({
          ...kit.template.manifest,
          name: 'Baked snapshot',
        }),
        'logo.png': makePng(100, 40),
        // A slot the generic style does not use: sealed as an extra, not a pass asset.
        'strip.png': makePng(375, 144),
      }),
      { name: 'Baked snapshot' },
    );
    for (const [path, bytes] of baked.files) assets.files.set(path, bytes);
    // The kit already adopted the generated build; a different hash would be a superseded build.
    const source = sourceOf([baked], generatedSource.hash);
    resetBakedSync();
    await syncBakedTemplates(kit.ctx, source);
    const registry = createTemplateRegistry(kit.env, { ctx: kit.ctx, source });
    const canonical = await registry.resolve(baked.template.id, baked.template.version);
    const pass = await makePass(kit.fx, { orgId: kit.org.id, template: canonical });
    const { binding, snapshot } = await capture(kit, pass.id);
    resetBakedSync();
    await syncBakedTemplates(kit.ctx, source);
    expect((await capture(kit, pass.id)).snapshot).toEqual(snapshot);
    const resolved = await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit');
    expect(resolved).toEqual({ pinned: canonical, active: canonical });
    expect(resolved?.pinned.origin).toBe('baked');
    expect(resolved?.pinned.assets.length).toBeGreaterThan(0);
    expect(resolved?.pinned.assets.every((asset) => asset.source.kind === 'r2')).toBe(true);
    const extra = await first<{ r2_key: string }>(
      kit.env.DB,
      'SELECT r2_key FROM template_version_extras WHERE template_id=? AND version=? AND name=?',
      [baked.template.id, baked.template.version, 'strip.png'],
    );
    if (!extra) throw new Error('Expected a sealed extra');
    await kit.env.BUCKET.put(extra.r2_key, makePng(375, 145));
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).toBeNull();
  });
});
