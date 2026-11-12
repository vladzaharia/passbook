import { expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { setArchived } from '../templates/lifecycle.ts';
import { effectiveReleaseIdSql } from '../templates/repo-release-heads.ts';
import { candidateById, candidatesByScopes } from './repo-lookup.ts';
import { registerLookupLegacyUnapprovedCase } from './repo-lookup-release-legacy-test-fixtures.ts';
import { CHECK_IN, kit, stageVersion } from './repo-lookup-release-test-fixtures.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { foundOf } from './resolve.ts';
import { candidateAudit } from './resolve-candidates.ts';
import { makeLegacyScanPass } from './test-kit.ts';

export function registerLookupReleaseScopedCases() {
  it('selects the approved Apple head for the exact organization and mode, not the legacy pointer', async () => {
    const templateId = await kit.scanTemplate('Scoped candidate', { actions: [CHECK_IN] });
    const base = await kit.registry.resolve(templateId, 'v1');
    await run(kit.env.DB, 'UPDATE templates SET org_id=NULL WHERE id=?', [templateId]);
    kit.registry.add({
      id: templateId,
      orgId: null,
      version: 'v1',
      manifest: base.manifest,
      passJson: base.passJson,
      assets: { 'icon.png': ICON_PNG },
    });
    const other = await makeOrg(kit.fx);
    const otherRelease = await approveAppleRelease(kit, {
      orgId: other.id,
      templateId,
      version: 'v1',
    });
    const live = await kit.scanPass(templateId);
    const test = await kit.scanPass(templateId, {}, { mode: 'test' });
    const otherPass = await kit.scanPass(templateId, {}, { orgId: other.id });
    const testBefore = await candidateById(kit.env.DB, kit.org.id, test.id);
    await stageVersion(templateId, 'v2');
    const liveRelease = await approveAppleRelease(kit, { templateId, version: 'v2', mode: 'live' });
    await run(kit.env.DB, 'UPDATE templates SET active_version=? WHERE id=?', ['v1', templateId]);

    const liveCandidate = await candidateById(kit.env.DB, kit.org.id, live.id);
    const testCandidate = await candidateById(kit.env.DB, kit.org.id, test.id);
    const otherCandidate = await candidateById(kit.env.DB, other.id, otherPass.id);
    expect(liveCandidate).toMatchObject({
      activeReleaseId: liveRelease.id,
      activeReleaseGeneration: liveRelease.generation,
      activeReleaseVersion: liveRelease.version,
      activeReleaseCandidateHash: liveRelease.candidateHash,
      activeTemplateVersion: 'v2',
    });
    expect(live.releaseId).toEqual(expect.any(String));
    expect(liveCandidate?.pass.releaseId).toBe(live.releaseId);
    expect(liveCandidate?.pass.releaseId).not.toBe(liveRelease.id);
    expect(testCandidate).toMatchObject({
      activeReleaseId: testBefore?.activeReleaseId,
      activeReleaseGeneration: testBefore?.activeReleaseGeneration,
      activeReleaseVersion: 'v1',
      activeTemplateVersion: 'v1',
    });
    expect(otherCandidate).toMatchObject({
      activeReleaseId: otherRelease.id,
      activeReleaseGeneration: otherRelease.generation,
      activeReleaseVersion: 'v1',
      activeReleaseCandidateHash: otherRelease.candidateHash,
    });
    expect(await candidateById(kit.env.DB, other.id, live.id)).toBeNull();
    expect(await candidateById(kit.env.DB, kit.org.id, otherPass.id)).toBeNull();
    let statements = 0;
    const bindingSizes: number[] = [];
    const countingDb = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            statements++;
            const prepared = target.prepare(sql);
            return new Proxy(prepared, {
              get(statement, member) {
                if (member === 'bind')
                  return (...values: unknown[]) => {
                    const slots = scanSecretSlots(sql, values.length);
                    if (!slots) throw new Error('Unrecognized scoped candidate bindings');
                    expect(slots.filter((slot) => slot.label === 'pass-id')).toHaveLength(
                      values.length / 3,
                    );
                    bindingSizes.push(values.length);
                    return statement.bind(...values);
                  };
                const value = Reflect.get(statement, member, statement);
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const liveScope = { orgId: kit.org.id, mode: 'live' as const, passId: live.id };
    const scoped = await candidatesByScopes(countingDb, [
      liveScope,
      liveScope,
      { orgId: kit.org.id, mode: 'test', passId: test.id },
      { orgId: other.id, mode: 'live', passId: otherPass.id },
      { orgId: other.id, mode: 'live', passId: live.id },
      { orgId: kit.org.id, mode: 'test', passId: live.id },
    ]);
    expect(statements).toBe(1);
    expect(scoped).toHaveLength(3);
    expect(scoped.find((candidate) => candidate.pass.id === live.id)).toEqual(liveCandidate);
    expect(scoped.find((candidate) => candidate.pass.id === test.id)).toEqual(testCandidate);
    expect(scoped.find((candidate) => candidate.pass.id === otherPass.id)).toEqual(otherCandidate);
    const many = await candidatesByScopes(countingDb, [
      ...Array.from({ length: 30 }, () => ({
        orgId: other.id,
        mode: 'live' as const,
        passId: live.id,
      })),
      liveScope,
      ...Array.from({ length: 30 }, () => ({
        orgId: kit.org.id,
        mode: 'test' as const,
        passId: live.id,
      })),
      liveScope,
      { orgId: other.id, mode: 'live', passId: otherPass.id },
    ]);
    expect(many.map((candidate) => candidate.pass.id).sort()).toEqual(
      [live.id, otherPass.id].sort(),
    );
    expect(bindingSizes).toEqual([18, 90, 90, 9]);
    expect(await candidatesByScopes(countingDb, [])).toEqual([]);
    await expect(
      candidatesByScopes(
        countingDb,
        Array.from({ length: 1001 }, () => liveScope),
      ),
    ).rejects.toThrow(RangeError);
    expect(statements).toBe(4);
    const found = liveCandidate && (await foundOf(kit.ctx, liveCandidate));
    expect(found).toMatchObject({
      activeReleaseId: liveRelease.id,
      activeReleaseGeneration: liveRelease.generation,
      identityPassTypeIdentifier: liveCandidate?.identityPassTypeIdentifier,
      identityTeamIdentifier: liveCandidate?.identityTeamIdentifier,
      identityRevision: liveCandidate?.identityRevision,
      transferPending: false,
      activeReleaseVersion: 'v2',
      activeReleaseCandidateHash: liveRelease.candidateHash,
      activeVersion: 'v2',
      activePolicy: { version: 'v2' },
      template: { version: 'v1' },
    });
    expect(liveCandidate && candidateAudit(liveCandidate).auditPassSnapshot).toMatchObject({
      releaseId: live.releaseId,
      passJsonSnapshot: liveCandidate?.passJson,
      identityId: live.identityId,
      serial: live.serial,
      credentialGeneration: live.credentialGeneration,
      lifecycleGeneration: live.lifecycleGeneration,
      transferPending: false,
      identityPassTypeIdentifier: liveCandidate?.identityPassTypeIdentifier,
      identityTeamIdentifier: liveCandidate?.identityTeamIdentifier,
      identityRevision: liveCandidate?.identityRevision,
      activeReleaseId: liveRelease.id,
      activeReleaseGeneration: liveRelease.generation,
      activeReleaseVersion: 'v2',
      activeReleaseCandidateHash: liveRelease.candidateHash,
    });
    const otherScope = await first<{ release_id: string | null }>(
      kit.env.DB,
      `SELECT (${effectiveReleaseIdSql({
        templateIdSql: 'p.template_id',
        orgIdSql: 'scope_org.id',
        modeSql: 'p.mode',
        providerSql: "'apple'",
      })}) AS release_id FROM passes p JOIN orgs scope_org ON scope_org.id=? WHERE p.id=?`,
      [other.id, live.id],
    );
    expect(otherScope?.release_id).toBe(otherRelease.id);

    const wrongProvider = await first<{ release_id: string | null }>(
      kit.env.DB,
      `SELECT (${effectiveReleaseIdSql({
        templateIdSql: 'p.template_id',
        orgIdSql: 'p.org_id',
        modeSql: 'p.mode',
        providerSql: "'google'",
      })}) AS release_id FROM passes p WHERE p.id=?`,
      [live.id],
    );
    expect(wrongProvider?.release_id).toBeNull();

    const otherTemplate = await kit.scanTemplate('Different issuance template', {
      actions: [CHECK_IN],
    });
    const foreign = await kit.scanPass(otherTemplate);
    if (!live.releaseId || !test.releaseId || !foreign.releaseId)
      throw new Error('Missing pinned issuance release');
    for (const releaseId of [test.releaseId, otherRelease.id, foreign.releaseId]) {
      await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [releaseId, live.id]);
      expect(await candidateById(kit.env.DB, kit.org.id, live.id)).toBeNull();
    }
    await run(kit.env.DB, 'UPDATE passes SET release_id=? WHERE id=?', [live.releaseId, live.id]);
  });
}

export function registerLookupLegacyReleaseCases() {
  registerLookupLegacyUnapprovedCase();

  it('keeps existing passes on their own release or pin when the template is archived', async () => {
    const templateId = await kit.scanTemplate('Archived release history', { actions: [CHECK_IN] });
    const release = await approveAppleRelease(kit, { templateId, version: 'v1' });
    const issued = await kit.scanPass(templateId);
    const legacy = await makeLegacyScanPass(kit.fx, {
      orgId: kit.org.id,
      template: await kit.registry.resolve(templateId),
    });
    const before = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    expect(before).toMatchObject({ pass: { releaseId: null }, activeReleaseId: release.id });
    expect(before && (await foundOf(kit.ctx, before))).toMatchObject({
      activeReleaseId: release.id,
    });
    await setArchived(kit.ctx, release.publisherAuth, templateId, true);
    // No head: a legacy pass uses its pinned version, an issued pass its own release.
    const candidate = await candidateById(kit.env.DB, kit.org.id, legacy.id);
    expect(candidate).toMatchObject({
      activeReleaseId: null,
      activeReleaseGeneration: null,
      activeReleaseVersion: null,
      activeReleaseCandidateHash: null,
      activeTemplateVersion: release.version,
      displayTemplateVersion: release.version,
    });
    expect(candidate && (await foundOf(kit.ctx, candidate))).toMatchObject({
      activeVersion: release.version,
    });
    const noHeadIssued = await candidateById(kit.env.DB, kit.org.id, issued.id);
    expect(noHeadIssued).toMatchObject({
      pass: { releaseId: release.id },
      activeReleaseId: release.id,
      activeTemplateVersion: release.version,
    });
    expect(noHeadIssued && (await foundOf(kit.ctx, noHeadIssued))).toMatchObject({
      activeReleaseId: release.id,
    });
    // A deleted template stops both.
    await run(kit.env.DB, "UPDATE templates SET status='deleted' WHERE id=?", [templateId]);
    expect(await candidateById(kit.env.DB, kit.org.id, legacy.id)).toBeNull();
    expect(await candidateById(kit.env.DB, kit.org.id, issued.id)).toBeNull();
  });
}
