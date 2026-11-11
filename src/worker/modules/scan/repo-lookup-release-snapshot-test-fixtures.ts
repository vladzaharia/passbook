import { expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { assetActorFor } from './asset-test-fixtures.ts';
import {
  liveTemplateSnapshotFromResult,
  liveTemplateSnapshotStmt,
} from './repo-live-template-snapshot.ts';
import { byIdStmt, candidateById, candidatesOf } from './repo-lookup.ts';
import { registerLookupReleaseSnapshotGrantCase } from './repo-lookup-release-snapshot-grant-test-fixtures.ts';
import { CHECK_IN, credentialKeysetCommitment, kit } from './repo-lookup-release-test-fixtures.ts';
import { foundOf } from './resolve.ts';
import { candidateAudit } from './resolve-candidates.ts';
import { evaluate } from './resolve-evaluate.ts';

export function registerLookupReleaseSnapshotCases() {
  it('uses an identical approved version even when its legacy build key is null', async () => {
    const templateId = await kit.scanTemplate('Same version without build key', {
      actions: [CHECK_IN],
    });
    const pass = await kit.scanPass(templateId);
    const version = await first<{ build_key: string | null }>(
      kit.env.DB,
      'SELECT build_key FROM template_versions WHERE template_id=? AND version=?',
      [templateId, pass.templateVersion],
    );
    expect(version?.build_key).toBeNull();
    const [candidateResult, templateResult] = await kit.env.DB.batch([
      byIdStmt(kit.env.DB, kit.org.id, pass.id),
      liveTemplateSnapshotStmt(kit.env.DB, kit.org.id, pass.mode, pass.id),
    ]);
    const candidate = candidatesOf(candidateResult)[0];
    expect(candidate?.templateSnapshot).toEqual(liveTemplateSnapshotFromResult(templateResult));
    expect(candidate).toMatchObject({
      activeTemplateVersion: pass.templateVersion,
      displayTemplateVersion: pass.templateVersion,
    });
    if (!candidate?.templateSnapshot) throw new Error('Missing original template snapshot');
    expect(JSON.parse(candidate.templateSnapshot.raw)).toMatchObject({
      passId: pass.id,
      orgId: pass.orgId,
      mode: pass.mode,
      templateId,
      pinnedVersion: pass.templateVersion,
      pinned: { version: pass.templateVersion },
      active: { version: pass.templateVersion },
      release: { id: candidate.activeReleaseId, version: pass.templateVersion },
    });
    expect(await foundOf(kit.ctx, candidate)).not.toBeNull();
    const raw = candidateResult?.results?.[0];
    if (!candidateResult || !raw || typeof raw !== 'object')
      throw new Error('Missing raw candidate');
    for (const image_generation of [undefined, null, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        candidatesOf({
          ...candidateResult,
          results: [{ ...raw, image_generation }],
        }),
      ).toEqual([]);
    }
  });

  it('captures raw pass data and member photo lineage with the evaluated candidate', async () => {
    const templateId = await kit.scanTemplate('Candidate photo snapshot', { actions: [CHECK_IN] });
    const pass = await kit.scanPass(templateId, { memberName: 'Snapshot person' });
    const original = await candidateById(kit.env.DB, kit.org.id, pass.id);
    const raw = await first<{
      personalization: string;
      field_sources: string;
      image_generation: number;
    }>(
      kit.env.DB,
      'SELECT personalization, field_sources, image_generation FROM passes WHERE id=?',
      [pass.id],
    );
    if (!original || !raw) throw new Error('Missing candidate snapshot');
    expect(original.pass.imageGeneration).toBe(raw.image_generation);
    expect(original).toMatchObject({
      credentialKeysetCommitment,
      assetPhoto: null,
      hasPhoto: false,
      passPersonalizationSnapshot: raw.personalization,
      fieldSourcesSnapshot: raw.field_sources,
    });

    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    const actor = { type: 'system' as const, id: null };
    await putMemberPhoto(kit.ctx, actor, pass.id, { png, includeInPass: false }, null);
    const photo = await first<{
      version: string;
      r2_key: string;
      sha1: string;
      include_in_pass: number;
    }>(
      kit.env.DB,
      'SELECT version, r2_key, sha1, include_in_pass FROM member_photos WHERE pass_id=?',
      [pass.id],
    );
    const epoch = await first<{ image_generation: number }>(
      kit.env.DB,
      'SELECT image_generation FROM passes WHERE id=?',
      [pass.id],
    );
    const observed = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!photo || !observed || !epoch) throw new Error('Missing photo snapshot');
    expect(epoch.image_generation).toBeGreaterThan(raw.image_generation);
    expect(observed.pass.imageGeneration).toBe(epoch.image_generation);
    const expectedPhoto = {
      version: photo.version,
      key: photo.r2_key,
      sha1: photo.sha1,
      includeInPass: photo.include_in_pass,
    };
    expect(observed).toMatchObject({
      credentialKeysetCommitment,
      assetPhoto: expectedPhoto,
      hasPhoto: true,
      passPersonalizationSnapshot: raw.personalization,
      fieldSourcesSnapshot: raw.field_sources,
    });
    expect(await foundOf(kit.ctx, observed)).toMatchObject({
      credentialKeysetCommitment,
      pass: { imageGeneration: epoch.image_generation },
      assetPhoto: expectedPhoto,
      passPersonalizationSnapshot: raw.personalization,
      fieldSourcesSnapshot: raw.field_sources,
    });
    expect(candidateAudit(observed).auditPassSnapshot).toMatchObject({
      credentialKeysetCommitment,
      imageGeneration: epoch.image_generation,
      assetPhoto: expectedPhoto,
      passPersonalizationSnapshot: raw.personalization,
      fieldSourcesSnapshot: raw.field_sources,
    });
    await putMemberPhoto(kit.ctx, actor, pass.id, { png, includeInPass: false }, null);
    expect((await candidateById(kit.env.DB, kit.org.id, pass.id))?.assetPhoto?.version).not.toBe(
      photo.version,
    );
    expect(observed.assetPhoto).toEqual(expectedPhoto);
    expect(original.pass.imageGeneration).toBe(raw.image_generation);
    expect(observed.pass.imageGeneration).toBe(epoch.image_generation);
    expect(original.assetPhoto).toBeNull();
  });

  registerLookupReleaseSnapshotGrantCase();

  it.each([
    { configured: false, withEvent: false },
    { configured: true, withEvent: false },
    { configured: false, withEvent: true },
  ])(
    'finishes evaluation reads with configured=$configured event=$withEvent',
    async ({ configured, withEvent }) => {
      const templateId = await kit.scanTemplate('Batched evaluation reads', {
        actions: [CHECK_IN],
      });
      const pass = await kit.scanPass(templateId);
      const event = withEvent ? await kit.event({ templateIds: [templateId] }) : null;
      const scanner = await kit.scanner(
        event ? { eventId: event.id } : { templateIds: [templateId] },
      );
      const actor = await assetActorFor(kit, scanner);
      if (event) expect(actor.event?.id).toBe(event.id);
      const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
      if (!candidate) throw new Error('Missing evaluated candidate');
      candidate.checkInRules = configured ? { mode: 'single' } : {};
      let finished = 0;
      const evaluated = await evaluate(
        kit.ctx,
        actor,
        { passId: pass.id, method: 'manual' },
        {},
        {
          credentialKeysetCommitment: candidate.credentialKeysetCommitment,
          credentialTombstoneRefs: [],
          otherModeCredentialTombstoneRefs: [],
        },
        {
          candidateRead: { candidates: [candidate] },
          prepareReads: async (found) => {
            expect(found.pass.id).toBe(pass.id);
            return {
              stmts: [kit.env.DB.prepare('SELECT 37 AS marker')],
              finish: async (results) => {
                expect(results[0]?.results).toEqual([{ marker: 37 }]);
                finished++;
              },
            };
          },
        },
      );
      expect(finished).toBe(1);
      expect(evaluated.stop).toBe(false);
      if (!evaluated.stop) {
        expect(evaluated.found.admission !== undefined).toBe(configured);
        expect(evaluated.found.eventAdmission !== undefined).toBe(withEvent && !configured);
        if (withEvent && !configured) {
          expect(evaluated.found.eventAdmission?.state.direction).toBe('in');
          expect(evaluated.found.eventAdmissionReason).toBeNull();
        }
      }
    },
  );
}
