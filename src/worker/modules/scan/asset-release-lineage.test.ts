import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import { assetGrantValid, mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
beforeAll(async () => {
  kit = await setupScanKit();
  template = await kit.scanTemplate('Asset approved release', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function setup() {
  const scanner = await kit.scanner({ templateIds: [template] });
  const actor = await assetActorFor(kit, scanner);
  const pass = await kit.scanPass(template);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (
    !candidate?.activeReleaseId ||
    !candidate.activeReleaseVersion ||
    candidate.activeReleaseGeneration === null ||
    !candidate.activeReleaseCandidateHash
  )
    throw new Error('Approved release fixture missing');
  const grant = await mintAssetGrant(
    kit.ctx,
    actor,
    candidate,
    candidate.connectionGeneration,
    candidate.activeTemplateVersion,
    undefined,
    false,
    'commit',
  );
  return { scanner, actor, pass, candidate, grant };
}

describe('scanner asset approved-release lineage', () => {
  it('rejects a previous approved release after the same version is republished', async () => {
    const { scanner, actor, pass, candidate, grant } = await setup();
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId: template,
      version: candidate.activeReleaseVersion!,
    });
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current) throw new Error('Pass fixture missing');
    expect(current.activeReleaseVersion).toBe(candidate.activeReleaseVersion);
    expect(current.activeReleaseId).not.toBe(candidate.activeReleaseId);
    expect(current.activeReleaseGeneration).toBeGreaterThan(candidate.activeReleaseGeneration!);
    const staleRelease = {
      ...current,
      activeReleaseId: candidate.activeReleaseId,
      activeReleaseGeneration: candidate.activeReleaseGeneration,
      activeReleaseVersion: candidate.activeReleaseVersion,
      activeReleaseCandidateHash: candidate.activeReleaseCandidateHash,
    };
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        staleRelease,
        current.connectionGeneration,
        current.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        current,
        current.connectionGeneration,
        grant,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const next = await mintAssetGrant(
      kit.ctx,
      actor,
      current,
      current.connectionGeneration,
      current.activeTemplateVersion,
      undefined,
      false,
      'commit',
    );
    expect(
      (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${next}`)).status,
    ).toBe(200);
  });

  it('requires every evaluated release field and an exact candidate hash', async () => {
    const { actor, candidate } = await setup();
    for (const stale of [
      { ...candidate, activeReleaseId: null },
      { ...candidate, activeReleaseGeneration: null },
      { ...candidate, activeReleaseVersion: null },
      { ...candidate, activeReleaseCandidateHash: null },
      { ...candidate, displayTemplateVersion: null },
      { ...candidate, displayTemplateVersion: 'another-version' },
      { ...candidate, activeReleaseId: 'another-release' },
      { ...candidate, activeReleaseGeneration: (candidate.activeReleaseGeneration ?? 0) + 1 },
      { ...candidate, activeReleaseVersion: 'another-version' },
      { ...candidate, activeReleaseCandidateHash: '0'.repeat(64) },
    ]) {
      await expect(
        mintAssetGrant(
          kit.ctx,
          actor,
          stale,
          candidate.connectionGeneration,
          candidate.activeTemplateVersion,
          undefined,
          false,
          'commit',
        ),
      ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    }
  });

  it('rejects a snapshot whose issuing release belongs to another template', async () => {
    const { scanner, actor, pass, candidate, grant } = await setup();
    const foreignTemplate = await kit.scanTemplate('Foreign issuing release', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const foreign = await kit.scanPass(foreignTemplate);
    if (!foreign.releaseId) throw new Error('Foreign release fixture missing');
    await run(kit.env.DB, 'UPDATE passes SET release_id = ? WHERE id = ?', [
      foreign.releaseId,
      pass.id,
    ]);
    const forged = { ...candidate, pass: { ...candidate.pass, releaseId: foreign.releaseId } };
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        forged,
        forged.connectionGeneration,
        forged.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('uses the scoped release instead of the unscoped legacy active_version pointer', async () => {
    const { scanner, actor, pass } = await setup();
    const legacy = await kit.env.DB.prepare('SELECT active_version FROM templates WHERE id = ?')
      .bind(template)
      .first<{ active_version: string | null }>();
    if (!legacy) throw new Error('Template fixture missing');
    await run(kit.env.DB, 'UPDATE templates SET active_version = NULL WHERE id = ?', [template]);
    try {
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Pass fixture missing');
      const grant = await mintAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        undefined,
        false,
        'commit',
      );
      expect(
        (await kit.get(scanner.headers, `/passes/${pass.id}/assets/icon.png?g=${grant}`)).status,
      ).toBe(200);
    } finally {
      await run(kit.env.DB, 'UPDATE templates SET active_version = ? WHERE id = ?', [
        legacy.active_version,
        template,
      ]);
    }
  });
});
