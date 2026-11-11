import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makePass } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { noScopedReleaseSql } from '../templates/repo-releases.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import { assetActorFor, observeCancellation } from './asset-test-fixtures.ts';
import { mintAssetGrant } from './assets.ts';
import { candidateById } from './repo-lookup.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
});

async function legacyPass() {
  const templateId = await kit.scanTemplate(
    'Legacy asset template',
    {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    },
    { releaseModes: [] },
  );
  const template = await kit.registry.resolve(templateId);
  await run(
    kit.env.DB,
    `INSERT INTO template_versions
    (template_id, version, build_key, manifest, pass_json, assets, report, created_at)
    SELECT template_id, 'unapproved-draft', build_key, manifest, pass_json, assets, report, created_at
    FROM template_versions WHERE template_id = ? AND version = ?`,
    [templateId, template.version],
  );
  const pass = await makePass(kit.fx, { orgId: kit.org.id, template });
  const identity = await kit.env.DB.prepare(`SELECT i.pass_type_identifier, i.team_identifier
    FROM passes p JOIN signing_identities i ON i.id = p.identity_id WHERE p.id = ?`)
    .bind(pass.id)
    .first<{ pass_type_identifier: string; team_identifier: string }>();
  if (!identity) throw new Error('Legacy signing identity missing');
  await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
    JSON.stringify({
      ...template.passJson,
      serialNumber: pass.serial,
      passTypeIdentifier: identity.pass_type_identifier,
      teamIdentifier: identity.team_identifier,
    }),
    pass.id,
  ]);
  const scanner = await kit.scanner({ templateIds: [templateId] });
  const actor = await assetActorFor(kit, scanner);
  const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
  if (!candidate) throw new Error('Legacy pass fixture missing');
  return { templateId, template, pass, scanner, actor, candidate };
}

describe('legacy scanner asset lineage', () => {
  it('uses the pinned version despite an unapproved draft and no scoped release history', async () => {
    const { template, pass, scanner, actor, candidate } = await legacyPass();
    expect(candidate.pass.releaseId).toBeNull();
    expect(candidate.activeReleaseId).toBeNull();
    expect(candidate.activeReleaseGeneration).toBeNull();
    expect(candidate.activeReleaseVersion).toBeNull();
    expect(candidate.activeReleaseCandidateHash).toBeNull();
    expect(candidate.activeTemplateVersion).toBe(template.version);
    expect(candidate.displayTemplateVersion).toBe(template.version);
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
    const response = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeNull();
  });

  it('invalidates the fallback when a first scoped approved head is published', async () => {
    const { templateId, template, pass, scanner, actor, candidate } = await legacyPass();
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
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId,
      version: template.version,
    });
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const oldResponse = await kit.get(
      scanner.headers,
      `/passes/${pass.id}/assets/icon.png?g=${grant}`,
    );
    expect(oldResponse.status).toBe(404);
    expect(await oldResponse.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current?.activeReleaseId) throw new Error('Approved head fixture missing');
    expect(current.pass.releaseId).toBeNull();
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

  it('cancels an open legacy photo if its first approved head appears during R2 access', async () => {
    const { templateId, template, pass, scanner, actor } = await legacyPass();
    const png = makePng(270, 270);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      {
        png: btoa(String.fromCharCode(...png)),
        includeInPass: false,
      },
      null,
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const photo = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!candidate || !photo) throw new Error('Legacy photo fixture missing');
    const grant = await mintAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      undefined,
      true,
      'commit',
    );
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let opened = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
      const object = await originalGet(key, options);
      if (key !== photo.r2_key || !object) return object;
      opened = true;
      await approveAppleRelease(kit, {
        orgId: kit.org.id,
        mode: 'live',
        templateId,
        version: template.version,
      });
      return observeCancellation(object, () => cancelled++);
    });
    let response: Response;
    try {
      response = await kit.get(scanner.headers, `/passes/${pass.id}/assets/member.png?g=${grant}`);
    } finally {
      spy.mockRestore();
    }
    expect(opened).toBe(true);
    expect(cancelled).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('never reopens fallback when raw release history exists but no head is usable', async () => {
    const { templateId, template, pass, actor } = await legacyPass();
    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      mode: 'live',
      templateId,
      version: template.version,
    });
    await setTemplateStatus(kit.env.DB, templateId, 'archived', kit.clock.now());
    const absence = noScopedReleaseSql({
      templateIdSql: 'p.template_id',
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
      providerSql: "'apple'",
    });
    const row = await kit.env.DB.prepare(
      `SELECT (${absence}) AS absent FROM passes p WHERE p.id = ?`,
    )
      .bind(pass.id)
      .first<{ absent: number }>();
    expect(row?.absent).toBe(0);
    const current = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!current) throw new Error('Legacy pass fixture missing');
    const fakeFallback = {
      ...current,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    };
    await expect(
      mintAssetGrant(
        kit.ctx,
        actor,
        fakeFallback,
        current.connectionGeneration,
        template.version,
        undefined,
        false,
        'commit',
      ),
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });
});
