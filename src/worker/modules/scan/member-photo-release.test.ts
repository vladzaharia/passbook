import { beforeAll, describe, expect, it } from 'vitest';
import { persistTemplate } from '../../../../test/helpers/index.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { setTemplateStatus } from '../templates/testing.ts';
import { scannerActor, withRole } from './actor.ts';
import { grantInsertConfirmed } from './asset-grant-results.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import {
  assetGrantValid,
  confirmAssetGrantToken,
  prepareGenericAssetGrant,
  preparePhotoGrant,
} from './assets.ts';
import { canShowPhotoForCandidate, knownPhotoUrl, scannerReleaseAllowed } from './member-photo.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
let template: string;
const bytes = makePng(270, 270);
const png = btoa(String.fromCharCode(...bytes));
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  template = await kit.scanTemplate('Photo membership', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
});

async function stageVersion(templateId: string, version: string) {
  const base = await kit.registry.resolve(templateId, 'v1');
  const manifest = structuredClone(base.manifest);
  manifest.inputs.properties!.memberName = { type: 'string', 'x-scan': 'manager' };
  const staged = kit.registry.add({
    id: templateId,
    orgId: base.orgId,
    version,
    manifest,
    passJson: { ...base.passJson, description: `Changed artifact ${version}` },
    assets: { 'icon.png': ICON_PNG },
  });
  await persistTemplate(kit.fx, staged, { registry: kit.registry });
  await approveAppleRelease(kit, { templateId, mode: 'live', version });
}

describe('scanner member photo release authority', () => {
  it('separates generic and photo capabilities across both photo asset names', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      jobCtxOf(kit),
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: true },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const actor = await assetActorFor(kit, scanner);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Photo candidate missing');
    const generic = await prepareGenericAssetGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
      'read',
    );
    const photo = await preparePhotoGrant(
      kit.ctx,
      actor,
      candidate,
      candidate.connectionGeneration,
      candidate.activeTemplateVersion,
    );
    if (!generic || !photo) throw new Error('Asset grant plans missing');
    const [genericBind, photoBind] = await Promise.all([
      prepareAssetGrantInsertion(kit.ctx, generic, undefined, candidate),
      prepareAssetGrantInsertion(kit.ctx, photo, undefined, candidate),
    ]);
    const now = kit.clock.now();
    const genericStatements = genericBind(now, undefined);
    const photoStatements = photoBind(now, undefined);
    const [output, ...results] = await kit.env.DB.batch([
      kit.env.DB.prepare('SELECT 42 AS output_marker'),
      ...genericStatements,
      ...photoStatements,
    ]);
    expect(output?.results).toEqual([{ output_marker: 42 }]);
    const genericResults = results.slice(0, genericStatements.length);
    const photoResults = results.slice(genericStatements.length);
    expect(grantInsertConfirmed(genericResults)).toBe(true);
    expect(grantInsertConfirmed(photoResults)).toBe(true);
    const genericToken = confirmAssetGrantToken(generic, genericResults);
    const photoToken = confirmAssetGrantToken(photo, photoResults);
    if (!genericToken || !photoToken) throw new Error('Confirmed asset grants missing');
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        genericToken,
        undefined,
        'read',
        false,
      ),
    ).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        genericToken,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        genericToken,
        undefined,
        'read',
        true,
      ),
    ).toBe(false);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        photoToken,
        undefined,
        'commit',
        true,
      ),
    ).toBe(true);
    expect(
      await assetGrantValid(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        photoToken,
        undefined,
        'commit',
        false,
      ),
    ).toBe(false);
    for (const name of ['member.png', 'thumbnail@3x.png']) {
      const denied = await kit.get(
        scanner.headers,
        `/passes/${pass.id}/assets/${name}?g=${genericToken}`,
      );
      expect(denied.status).toBe(404);
      const body = await denied.text();
      expect(body).not.toContain(genericToken);
      expect(body).not.toContain(photoToken);
      const allowed = await kit.get(
        scanner.headers,
        `/passes/${pass.id}/assets/${name}?g=${photoToken}`,
      );
      expect(allowed.status).toBe(200);
      expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(bytes);
    }
  });

  it.each(['release', 'template'] as const)(
    'serves generic assets but denies photos for an incompatible release and revokes on %s races',
    async (race) => {
      const templateId = await kit.scanTemplate('Incompatible asset read', {
        actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
      });
      const pass = await kit.scanPass(templateId);
      await putMemberPhoto(
        kit.ctx,
        { type: 'system', id: null },
        pass.id,
        { png, includeInPass: false },
        null,
      );
      const scanner = await kit.scanner({ templateIds: [templateId] });
      const actor = await assetActorFor(kit, scanner);
      await stageVersion(templateId, 'v2');
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Incompatible candidate missing');
      expect(candidate.displayTemplateVersion).toBeNull();
      const plan = await prepareGenericAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        'read',
      );
      if (!plan) throw new Error('Generic read plan missing');
      const bind = await prepareAssetGrantInsertion(kit.ctx, plan, undefined, candidate);
      const inserted = await kit.env.DB.batch(bind(kit.clock.now(), undefined));
      expect(grantInsertConfirmed(inserted)).toBe(true);
      const grant = confirmAssetGrantToken(plan, inserted);
      if (!grant) throw new Error('Confirmed generic read grant missing');
      const image = (name: string) =>
        kit.get(scanner.headers, `/passes/${pass.id}/assets/${name}?g=${grant}`);
      expect((await image('icon.png')).status).toBe(200);
      expect((await image('member.png')).status).toBe(404);
      const pinned = await kit.registry.resolve(templateId, candidate.pass.templateVersion);
      expect(await knownPhotoUrl(kit.ctx, actor, candidate, pinned)).toBeNull();

      const pending = await prepareGenericAssetGrant(
        kit.ctx,
        actor,
        candidate,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        'read',
      );
      if (!pending) throw new Error('Generic read plan missing');
      const bindPending = await prepareAssetGrantInsertion(kit.ctx, pending, undefined, candidate);
      if (race === 'release') await stageVersion(templateId, 'v3');
      else {
        await setTemplateStatus(kit.env.DB, templateId, 'archived', kit.clock.now());
        await setTemplateStatus(kit.env.DB, templateId, 'active', kit.clock.now());
      }
      if (race === 'template') {
        // Status A-B-A leaves the same template standing: the grant stands too.
        expect(
          grantInsertConfirmed(await kit.env.DB.batch(bindPending(kit.clock.now(), undefined))),
        ).toBe(true);
        return;
      }
      await expect(kit.env.DB.batch(bindPending(kit.clock.now(), undefined))).rejects.toThrow(
        'scan_asset_authority_failed',
      );
      expect(confirmAssetGrantToken(pending, undefined)).toBeNull();
      expect((await image('icon.png')).status).toBe(404);
    },
  );

  it('requires a complete current approved release before issuing a photo', async () => {
    const pass = await kit.scanPass(template);
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const scanner = await kit.scanner({ templateIds: [template] });
    const row = await getScanner(kit.env.DB, scanner.id);
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!row || !candidate?.activeReleaseId || !candidate.activeReleaseVersion)
      throw new Error('Missing approved-release fixture.');
    const actor = withRole(
      await proofedScanActor(
        kit.ctx,
        scannerActor(kit.ctx, row, 'live', 'cookie', { event: null, templateIds: [template] }),
      ),
      null,
    );
    expect(await canShowPhotoForCandidate(kit.ctx, actor, candidate)).toBe(true);
    for (const invalid of [
      { ...candidate, activeReleaseId: null },
      { ...candidate, activeReleaseGeneration: null },
      { ...candidate, activeReleaseGeneration: 0 },
      { ...candidate, activeReleaseVersion: null },
      { ...candidate, activeReleaseCandidateHash: null },
      { ...candidate, activeReleaseCandidateHash: 'invalid' },
      { ...candidate, activeReleaseVersion: 'different-release' },
    ]) {
      expect(await canShowPhotoForCandidate(kit.ctx, actor, invalid)).toBe(false);
    }
    const incompatible = {
      ...candidate,
      pass: { ...candidate.pass, templateVersion: 'different-pinned-version' },
      displayTemplateVersion: null,
    };
    expect(scannerReleaseAllowed(incompatible)).toBe(false);
    expect(await canShowPhotoForCandidate(kit.ctx, actor, incompatible)).toBe(false);
    expect(
      scannerReleaseAllowed({
        ...incompatible,
        displayTemplateVersion: candidate.activeReleaseVersion,
      }),
    ).toBe(true);
    const legacy = {
      ...candidate,
      pass: { ...candidate.pass, releaseId: null },
      activeTemplateVersion: candidate.pass.templateVersion,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    };
    expect(scannerReleaseAllowed(legacy)).toBe(true);
    expect(scannerReleaseAllowed({ ...legacy, activeReleaseId: 'partial' })).toBe(false);
    expect(scannerReleaseAllowed({ ...legacy, displayTemplateVersion: null })).toBe(false);
    expect(scannerReleaseAllowed({ ...legacy, activeTemplateVersion: 'unapproved-draft' })).toBe(
      false,
    );
    // Shape alone does not prove that no approved release has appeared in D1.
    expect(await canShowPhotoForCandidate(kit.ctx, actor, legacy)).toBe(false);
  });
});
