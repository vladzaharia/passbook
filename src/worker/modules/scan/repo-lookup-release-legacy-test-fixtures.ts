import { expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { CHECK_IN, kit, stageVersion } from './repo-lookup-release-test-fixtures.ts';
import { passSnapshotCurrent } from './repo-pass-authority.ts';
import { foundOf } from './resolve.ts';
import { candidateAudit } from './resolve-candidates.ts';
import { key } from './test-kit.ts';

export function registerLookupLegacyUnapprovedCase() {
  it('uses pinned legacy policy only while scoped release history is absent', async () => {
    const scan = { actions: [CHECK_IN] };
    const donorId = await kit.scanTemplate('Legacy without approval', scan);
    const donor = await kit.registry.resolve(donorId);
    const legacy = await kit.scanPass(donorId, { memberName: 'Legacy Person' });
    const draftId = await kit.scanTemplate('Legacy without approval', scan, { releaseModes: [] });
    const template = await kit.registry.resolve(draftId);
    expect(template.manifest).toEqual(donor.manifest);
    expect(template.passJson).toEqual(donor.passJson);
    expect(template.assets).toEqual(donor.assets);
    const builds = await all<{ build_key: string | null }>(
      kit.env.DB,
      'SELECT build_key FROM template_versions WHERE template_id IN (?, ?) AND version=?',
      [donorId, draftId, template.version],
    );
    expect(builds).toHaveLength(2);
    expect(builds[0]?.build_key).toBe(builds[1]?.build_key);
    const snapshot = await first<{
      pass_json: string | null;
      personalization: string;
      version: number;
      template_version: string;
    }>(
      kit.env.DB,
      'SELECT pass_json, personalization, version, template_version FROM pass_versions WHERE pass_id=? ORDER BY version DESC LIMIT 1',
      [legacy.id],
    );
    if (!snapshot?.pass_json) throw new Error('Missing issued Wallet snapshot');
    // Stage a pre-release legacy row without changing the genuinely published Wallet snapshot.
    await run(
      kit.env.DB,
      'UPDATE passes SET template_id=?, template_version=?, release_id=NULL WHERE id=?',
      [draftId, template.version, legacy.id],
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    if (!candidate) throw new Error('Missing legacy candidate');
    expect(candidate).toMatchObject({
      pass: { releaseId: null, templateVersion: template.version },
      walletVersion: snapshot.version,
      walletTemplateVersion: snapshot.template_version,
      transferPending: false,
      versionPersonalization: snapshot.personalization,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
      activeTemplateVersion: template.version,
      displayTemplateVersion: template.version,
    });
    expect(candidateAudit(candidate).auditPassSnapshot).toMatchObject({
      releaseId: null,
      activeTemplateVersion: template.version,
      passJsonSnapshot: snapshot.pass_json,
      walletVersion: snapshot.version,
      walletTemplateVersion: snapshot.template_version,
      versionPersonalization: snapshot.personalization,
      identityId: candidate.pass.identityId,
      serial: candidate.pass.serial,
      credentialGeneration: candidate.pass.credentialGeneration,
      lifecycleGeneration: candidate.pass.lifecycleGeneration,
      transferPending: false,
      identityPassTypeIdentifier: candidate.identityPassTypeIdentifier,
      identityTeamIdentifier: candidate.identityTeamIdentifier,
      identityRevision: candidate.identityRevision,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
    });
    expect(await foundOf(kit.ctx, candidate)).toMatchObject({
      activeVersion: template.version,
      displayTemplateVersion: template.version,
      passJsonSnapshot: snapshot.pass_json,
      walletVersion: snapshot.version,
      walletTemplateVersion: snapshot.template_version,
      transferPending: false,
      versionPersonalization: snapshot.personalization,
      identityPassTypeIdentifier: candidate.identityPassTypeIdentifier,
      identityTeamIdentifier: candidate.identityTeamIdentifier,
      identityRevision: candidate.identityRevision,
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
      template: { version: template.version },
      activePolicy: { version: template.version },
    });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        candidate.pass,
        candidate.connectionGeneration,
        candidate.activeTemplateVersion,
        candidate.orgRevision,
        candidate.templateRevision,
        kit.clock.now(),
        candidate,
      ),
    ).toBe(true);
    const scanner = await kit.scanner({ templateIds: [draftId] });
    const request = () => ({
      idempotencyKey: key(),
      input: { passId: legacy.id, method: 'manual' },
      clientTs: kit.clock.now(),
    });
    const response = await kit.post(scanner.headers, '/resolve', request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ready', card: { passId: legacy.id } });
    const action = await kit.post(scanner.headers, '/actions', {
      ...request(),
      actionId: 'check_in',
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({ kind: 'ok', reason: null });

    const beforeHead = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    if (!beforeHead) throw new Error('Missing pre-release snapshot');
    const release = await approveAppleRelease(kit, {
      templateId: draftId,
      version: template.version,
    });
    expect(
      await passSnapshotCurrent(
        kit.env.DB,
        beforeHead.pass,
        beforeHead.connectionGeneration,
        beforeHead.activeTemplateVersion,
        beforeHead.orgRevision,
        beforeHead.templateRevision,
        kit.clock.now(),
        beforeHead,
      ),
    ).toBe(false);
    const afterHead = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    expect(afterHead).toMatchObject({
      pass: { releaseId: null },
      activeReleaseId: release.id,
      activeReleaseGeneration: release.generation,
      activeReleaseVersion: template.version,
      activeReleaseCandidateHash: release.candidateHash,
      activeTemplateVersion: template.version,
    });
    expect(afterHead && (await foundOf(kit.ctx, afterHead))).toMatchObject({
      activeVersion: template.version,
      activeReleaseId: release.id,
    });

    await stageVersion(draftId, 'v2');
    await approveAppleRelease(kit, { templateId: draftId, version: 'v2' });
    const incompatible = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    expect(incompatible).toMatchObject({
      activeReleaseVersion: 'v2',
      displayTemplateVersion: null,
    });
    expect(incompatible && (await foundOf(kit.ctx, incompatible))).toMatchObject({
      activeVersion: 'v2',
      displayTemplateVersion: null,
      activePolicy: { version: 'v2' },
      template: { version: template.version },
    });
    const blocked = await kit.post(scanner.headers, '/actions', {
      ...request(),
      actionId: 'check_in',
    });
    expect(await blocked.json()).toMatchObject({ reason: 'not_found', card: null, display: null });
  });
}
