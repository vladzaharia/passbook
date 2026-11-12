import { describe, expect, it } from 'vitest';
import { countD1, makeOrg, persistTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { createTemplateRegistry, r2Key } from '../templates/registry.ts';
import { rollbackRelease } from '../templates/releases.ts';
import type { FakeAssets } from '../templates/testing.ts';
import { verifyLiveTemplateSnapshot } from './live-template-snapshot.ts';
import {
  liveTemplateSnapshotFromResult,
  liveTemplateSnapshotStmt,
} from './repo-live-template-snapshot.ts';
import {
  capture,
  current,
  fixture,
  insertVersion,
} from './repo-live-template-snapshot-test-fixtures.ts';
import { byIdStmt, candidatesOf } from './repo-lookup.ts';

describe('live template snapshots', () => {
  it('matches the registry exactly for uploaded R2 assets and a same-version approved release', async () => {
    const { kit, pass } = await fixture({ buildKey: null });
    const { binding, snapshot } = await capture(kit, pass.id);
    const counted = countD1(kit.env.DB);
    const batched = await counted.db.batch([
      liveTemplateSnapshotStmt(counted.db, kit.org.id, 'live', pass.id),
      byIdStmt(counted.db, kit.org.id, pass.id),
    ]);
    expect(counted.count()).toBe(1);
    expect(liveTemplateSnapshotFromResult(batched[0])).toEqual(snapshot);
    const candidate = candidatesOf(batched[1])[0];
    expect(candidate?.templateSnapshot).toEqual(snapshot);
    expect(candidate?.displayTemplateVersion).toBe('v1');
    if (!candidate?.templateSnapshot) throw new Error('Missing candidate template snapshot');
    counted.reset();
    const countedCtx = { ...kit.ctx, env: { ...kit.env, DB: counted.db } };
    expect(
      await verifyLiveTemplateSnapshot(countedCtx, candidate, candidate.templateSnapshot, 'commit'),
    ).not.toBeNull();
    expect(counted.count()).toBe(0);
    const resolved = await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit');
    const canonical = await createTemplateRegistry(kit.env).resolve(binding.pass.templateId, 'v1');
    expect(resolved).toEqual({ pinned: canonical, active: canonical });
    expect(resolved?.pinned.assets).toHaveLength(1);
    expect(resolved?.pinned.assets[0]?.source.kind).toBe('r2');
    expect(await current(kit, binding, snapshot)).toBe(true);
  });

  it('preserves actual static asset metadata and fails closed when those bytes disappear', async () => {
    const { kit, pass } = await fixture({ static: true });
    const { binding, snapshot } = await capture(kit, pass.id);
    const canonical = await createTemplateRegistry(kit.env).resolve(binding.pass.templateId, 'v1');
    const resolved = await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit');
    expect(resolved?.pinned).toEqual(canonical);
    const source = canonical.assets[0]?.source;
    if (source?.kind !== 'static') throw new Error('Expected a static asset');
    (kit.env.ASSETS as FakeAssets).files.delete(source.path);
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).toBeNull();
  });

  it('selects the scoped approved head, never a draft, and fences a release change', async () => {
    const { kit, id, pass, release } = await fixture();
    if (!release) throw new Error('Expected an initial release');
    await insertVersion(kit, id, 'v2', 'same-build', { name: 'Approved next' });
    await insertVersion(kit, id, 'draft', 'same-build', { name: 'Unapproved draft' });
    await run(kit.env.DB, 'UPDATE templates SET active_version=? WHERE id=?', ['draft', id]);
    const original = await capture(kit, pass.id);
    expect(original.binding.activeReleaseVersion).toBe('v1');
    expect(
      (await verifyLiveTemplateSnapshot(kit.ctx, original.binding, original.snapshot, 'commit'))
        ?.active.version,
    ).toBe('v1');
    const second = await approveAppleRelease(kit, { templateId: id, version: 'v2', mode: 'live' });
    // Pure verification keeps the original pinned policy; only the final CAS can authorize it.
    expect(
      (await verifyLiveTemplateSnapshot(kit.ctx, original.binding, original.snapshot, 'commit'))
        ?.active.version,
    ).toBe('v1');
    expect(await current(kit, original.binding, original.snapshot)).toBe(false);
    const next = await capture(kit, pass.id);
    expect(next.binding.activeReleaseVersion).toBe('v2');
    const resolved = await verifyLiveTemplateSnapshot(
      kit.ctx,
      next.binding,
      next.snapshot,
      'commit',
    );
    const registry = createTemplateRegistry(kit.env);
    expect(resolved).toEqual({
      pinned: await registry.resolve(id, 'v1'),
      active: await registry.resolve(id, 'v2'),
    });
    expect(resolved?.active.manifest.name).toBe('Approved next');
    expect(await current(kit, next.binding, next.snapshot)).toBe(true);
    await rollbackRelease(kit.ctx, release.publisherAuth, id, {
      orgId: kit.org.id,
      mode: 'live',
      provider: 'apple',
      releaseId: release.id,
      candidateHash: release.candidateHash,
      expectedGeneration: second.generation,
      reason: 'Restore the previously approved template version',
    });
    expect(await current(kit, original.binding, original.snapshot)).toBe(false);
    expect(await current(kit, next.binding, next.snapshot)).toBe(false);
    const restored = await capture(kit, pass.id);
    expect(restored.binding.activeReleaseVersion).toBe('v1');
    expect(restored.binding.activeReleaseGeneration).toBe(second.generation + 1);
    expect(
      await verifyLiveTemplateSnapshot(kit.ctx, restored.binding, restored.snapshot, 'commit'),
    ).toEqual({
      pinned: await registry.resolve(id, 'v1'),
      active: await registry.resolve(id, 'v1'),
    });
  });

  it('prevents replacing, updating or deleting a referenced immutable version', async () => {
    const { kit, id, pinned, pass } = await fixture();
    const { binding, snapshot } = await capture(kit, pass.id);
    await persistTemplate(kit.fx, pinned);
    expect((await capture(kit, pass.id)).snapshot).toEqual(snapshot);
    await expect(
      persistTemplate(kit.fx, {
        ...pinned,
        manifest: { ...pinned.manifest, name: 'Attempted rewrite' },
      }),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'UPDATE template_versions SET manifest=? WHERE template_id=? AND version=?', [
        '{}',
        id,
        'v1',
      ]),
    ).rejects.toThrow();
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO template_versions
       SELECT * FROM template_versions WHERE template_id=? AND version=?`,
        [id, 'v1'],
      ),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'DELETE FROM template_versions WHERE template_id=? AND version=?', [
        id,
        'v1',
      ]),
    ).rejects.toThrow();
    expect(await current(kit, binding, snapshot)).toBe(true);
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).not.toBeNull();
  });

  it.each([
    ['same-build', 'other-build'],
    ['same-build', null],
    [null, 'same-build'],
    [null, null],
  ] as const)(
    'rejects incompatible builds (%s, %s) for live disclosure',
    async (pinnedKey, activeKey) => {
      const { kit, id, pass } = await fixture({ buildKey: pinnedKey });
      await insertVersion(kit, id, 'v2', activeKey);
      await approveAppleRelease(kit, { templateId: id, version: 'v2', mode: 'live' });
      const { binding, snapshot } = await capture(kit, pass.id);
      expect(binding.activeReleaseVersion).toBe('v2');
      expect(binding.displayTemplateVersion).toBeNull();
      expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).toBeNull();
      expect(await current(kit, binding, snapshot)).toBe(false);
      const read = await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'read');
      const registry = createTemplateRegistry(kit.env);
      expect(read).toEqual({
        pinned: await registry.resolve(id, 'v1'),
        active: await registry.resolve(id, 'v2'),
      });
      expect(await current(kit, binding, snapshot, 'read')).toBe(true);
    },
  );

  it('uses the immutable pin for a legacy pass while no head applies', async () => {
    const { kit, id, pass } = await fixture({ approved: false });
    await insertVersion(kit, id, 'draft', 'same-build', { name: 'Draft must not leak' });
    await run(kit.env.DB, 'UPDATE templates SET active_version=? WHERE id=?', ['draft', id]);
    const legacy = await capture(kit, pass.id);
    expect(legacy.binding.activeReleaseId).toBeNull();
    expect(legacy.binding.activeTemplateVersion).toBe('v1');
    expect(
      (await verifyLiveTemplateSnapshot(kit.ctx, legacy.binding, legacy.snapshot, 'commit'))?.active
        .version,
    ).toBe('v1');
    expect(await current(kit, legacy.binding, legacy.snapshot)).toBe(true);
    await approveAppleRelease(kit, { templateId: id, version: 'draft', mode: 'live' });
    expect(await current(kit, legacy.binding, legacy.snapshot)).toBe(false);
    // Archiving removes the head; the existing pass keeps scanning under its own version.
    await run(kit.env.DB, "UPDATE templates SET status='archived' WHERE id=?", [id]);
    const archived = await capture(kit, pass.id);
    expect(archived.binding.activeReleaseId).toBeNull();
    expect(archived.binding.activeTemplateVersion).toBe('v1');
    expect(
      (await verifyLiveTemplateSnapshot(kit.ctx, archived.binding, archived.snapshot, 'commit'))
        ?.active.version,
    ).toBe('v1');
    expect(await current(kit, archived.binding, archived.snapshot)).toBe(true);
    await run(kit.env.DB, "UPDATE templates SET status='deleted' WHERE id=?", [id]);
    expect(await current(kit, archived.binding, archived.snapshot)).toBe(false);
  });

  it('does not authorize a pass against a template reassigned to another organization', async () => {
    const { kit, id, pass } = await fixture({ approved: false });
    const other = await makeOrg(kit.fx);
    await run(kit.env.DB, 'UPDATE templates SET org_id=? WHERE id=?', [other.id, id]);
    const { binding, snapshot } = await capture(kit, pass.id);
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).toBeNull();
    expect(await current(kit, binding, snapshot)).toBe(false);
  });

  it('fails closed on malformed nested policies and duplicate asset names, even for legacy data', async () => {
    const { kit, pass } = await fixture({ approved: false });
    const { binding, snapshot } = await capture(kit, pass.id);
    type Raw = {
      pinned: { manifest: string; assets: string };
      active: { manifest: string; assets: string };
    };
    for (const change of [
      (manifest: Record<string, unknown>) => {
        manifest.scan = { actions: [null] };
      },
      (manifest: Record<string, unknown>) => {
        manifest.bindings = [null];
      },
    ]) {
      const raw = JSON.parse(snapshot.raw) as Raw;
      const manifest = JSON.parse(raw.pinned.manifest) as Record<string, unknown>;
      change(manifest);
      raw.pinned.manifest = JSON.stringify(manifest);
      raw.active.manifest = raw.pinned.manifest;
      expect(
        await verifyLiveTemplateSnapshot(kit.ctx, binding, { raw: JSON.stringify(raw) }, 'commit'),
      ).toBeNull();
    }
    const raw = JSON.parse(snapshot.raw) as Raw;
    const assets = JSON.parse(raw.pinned.assets) as unknown[];
    raw.pinned.assets = JSON.stringify([...assets, assets[0]]);
    raw.active.assets = raw.pinned.assets;
    expect(
      await verifyLiveTemplateSnapshot(kit.ctx, binding, { raw: JSON.stringify(raw) }, 'commit'),
    ).toBeNull();
  });

  it('rejects cross-tenant, cross-mode, corrupt JSON, altered release and tampered asset bytes', async () => {
    const { kit, id, pass } = await fixture();
    const { binding, snapshot } = await capture(kit, pass.id);
    const other = await makeOrg(kit.fx);
    expect(
      liveTemplateSnapshotFromResult(
        await liveTemplateSnapshotStmt(kit.env.DB, other.id, 'live', pass.id).all(),
      ),
    ).toBeNull();
    expect(
      liveTemplateSnapshotFromResult(
        await liveTemplateSnapshotStmt(kit.env.DB, kit.org.id, 'test', pass.id).all(),
      ),
    ).toBeNull();
    expect(
      await verifyLiveTemplateSnapshot(
        kit.ctx,
        { ...binding, pass: { ...binding.pass, orgId: other.id } },
        snapshot,
        'commit',
      ),
    ).toBeNull();
    expect(
      await verifyLiveTemplateSnapshot(
        kit.ctx,
        { ...binding, activeReleaseCandidateHash: '0'.repeat(64) },
        snapshot,
        'commit',
      ),
    ).toBeNull();
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, { raw: '{' }, 'commit')).toBeNull();
    const data = JSON.parse(snapshot.raw) as { pinned: { manifest: string } };
    data.pinned.manifest = '{';
    const altered = { raw: JSON.stringify(data) };
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, altered, 'commit')).toBeNull();
    expect(await current(kit, binding, altered)).toBe(false);
    const wrongAuthor = JSON.parse(snapshot.raw) as {
      release: { candidate: { authorId: string } };
    };
    wrongAuthor.release.candidate.authorId = 'different-author';
    const alteredApproval = { raw: JSON.stringify(wrongAuthor) };
    expect(
      await verifyLiveTemplateSnapshot(kit.ctx, binding, alteredApproval, 'commit'),
    ).toBeNull();
    expect(await current(kit, binding, alteredApproval)).toBe(false);
    const key = r2Key(kit.org.id, id, 'v1', 'icon.png');
    await kit.env.BUCKET.put(key, makePng(39, 39));
    expect(await verifyLiveTemplateSnapshot(kit.ctx, binding, snapshot, 'commit')).toBeNull();
  });
});
