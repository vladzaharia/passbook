import { describe, expect, it } from 'vitest';
import { first, stmt } from '../../platform/db.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { candidateHash } from '../templates/release-content.ts';
import { activeRelease } from '../templates/releases.ts';
import { getCandidate } from '../templates/repo-releases.ts';
import {
  duringTemplateRead,
  expectScopedSession,
  legacyPass,
  legacyVersions,
  scopedRaceScanner,
  session,
} from './repo-session-releases-split-test-fixtures.ts';
import { setupScanKit } from './test-kit.ts';

describe('scanner session approved releases', () => {
  it('does not fall back to a legacy pin when an ineligible release is the latest history', async () => {
    const kit = await setupScanKit();
    const { id, pinned } = await legacyVersions(kit);
    await legacyPass(kit, pinned);
    const event = await kit.event({ templateIds: [id] });
    const scanner = await kit.scanner({
      eventId: event.id,
      settings: { acceptAllTemplates: true },
    });
    const legacy = await session(kit, scanner.headers);
    expect(legacy).toMatchObject({ state: 'ready', event: { id: event.id } });
    expect(legacy.templates).toMatchObject([{ id, name: 'Legacy version' }]);

    await approveAppleRelease(kit, {
      orgId: kit.org.id,
      templateId: id,
      mode: 'live',
      version: 'v2',
    });
    const release = await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple');
    if (!release?.candidateId || !release.approvalId)
      throw new Error('Expected a candidate-backed approved release');
    const candidate = await getCandidate(kit.env.DB, release.candidateId);
    if (!candidate) throw new Error('Expected the approved release candidate');
    const approved = await session(kit, scanner.headers);
    expect(approved).toMatchObject({ state: 'ready', event: { id: event.id } });
    expect(approved.templates).toMatchObject([{ id, name: 'Unapproved draft' }]);

    // Model an append-only release written by a newer adapter revision. The database
    // accepts its internally consistent candidate and approval, but current policy cannot use it.
    const now = kit.clock.now() + 1;
    const nextCandidateId = kit.fx.ids.id();
    const nextApprovalId = kit.fx.ids.id();
    const nextReleaseId = kit.fx.ids.id();
    const digest = await candidateHash({
      templateId: candidate.templateId,
      orgId: candidate.orgId,
      mode: candidate.mode,
      provider: candidate.provider,
      version: candidate.version,
      contentHash: candidate.contentHash,
      adapterRevision: 2,
      adapterCapabilities: candidate.adapterCapabilities,
      audiencePolicyRevision: candidate.audiencePolicyRevision,
      authorId: candidate.authorId,
      versionAuthorId: candidate.versionAuthorId,
      createdAt: now,
    });
    await kit.env.DB.batch([
      stmt(
        kit.env.DB,
        `INSERT INTO template_candidates
          (id, template_id, org_id, mode, provider, version, candidate_hash, content_hash,
           adapter_revision, adapter_capabilities, audience_policy_revision, author_id,
           version_author_id, created_at)
         SELECT ?, template_id, org_id, mode, provider, version, ?, content_hash,
           2, adapter_capabilities, audience_policy_revision, author_id, version_author_id, ?
         FROM template_candidates WHERE id = ?`,
        [nextCandidateId, digest, now, release.candidateId],
      ),
      stmt(
        kit.env.DB,
        `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at)
         SELECT ?, ?, ?, reviewer_id, ? FROM template_approvals WHERE id = ?`,
        [nextApprovalId, nextCandidateId, digest, now, release.approvalId],
      ),
      stmt(
        kit.env.DB,
        `INSERT INTO template_releases
          (id, template_id, org_id, mode, provider, generation, version, candidate_hash,
           content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
           source, action, candidate_id, approval_id, previous_release_id,
           rollback_of_release_id, created_by, created_at)
         SELECT ?, template_id, org_id, mode, provider, generation + 1, version, ?,
           content_hash, 2, adapter_capabilities, audience_policy_revision,
           'approved', 'release', ?, ?, id, NULL, created_by, ?
         FROM template_releases WHERE id = ?`,
        [nextReleaseId, digest, nextCandidateId, nextApprovalId, now, release.id],
      ),
    ]);
    expect(
      await first(
        kit.env.DB,
        'SELECT generation, adapter_revision FROM template_releases WHERE id = ?',
        [nextReleaseId],
      ),
    ).toEqual({ generation: release.generation + 1, adapter_revision: 2 });
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();

    for (const deviceRole of ['scan', 'customer', 'monitor'] as const) {
      const device =
        deviceRole === 'scan'
          ? scanner
          : await kit.scanner({
              eventId: event.id,
              deviceRole,
              settings: { acceptAllTemplates: true },
            });
      // With no eligible head the scope uses the latest release in scope, never the legacy pin.
      const result = await session(kit, device.headers);
      expect(result).toMatchObject({
        state: 'ready',
        workspace: null,
        scanner: { id: device.id, orgId: kit.org.id, mode: 'live', deviceRole },
      });
      expect(result.templates).toEqual(
        deviceRole === 'scan' ? [expect.objectContaining({ id, name: 'Unapproved draft' })] : [],
      );
      expect(JSON.stringify(result)).not.toContain('Legacy version');
    }
  });

  it('serves the captured legacy pin if the first approved release appears while resolving it', async () => {
    const kit = await setupScanKit();
    const { id, pinned } = await legacyVersions(kit);
    await legacyPass(kit, pinned);
    const { event, scanner } = await scopedRaceScanner(kit, id, 'legacy_entry');
    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toBeNull();
    expectScopedSession(
      await session(kit, scanner.headers),
      event.id,
      'legacy_entry',
      kit.clock.now(),
    );

    const race = duringTemplateRead(kit, id, 'v1', async () => {
      await approveAppleRelease(kit, {
        orgId: kit.org.id,
        templateId: id,
        mode: 'live',
        version: 'v2',
      });
    });
    let result: Awaited<ReturnType<typeof session>>;
    try {
      result = await session(kit, scanner.headers);
    } finally {
      race.restore();
    }
    expect(race.state.fired).toBe(true);

    expect(await activeRelease(kit.ctx, id, kit.org.id, 'live', 'apple')).toMatchObject({
      version: 'v2',
    });
    // Legacy stamps are fenced by their pass evidence, not by the absence of release history.
    expectScopedSession(result, event.id, 'legacy_entry', kit.clock.now());
    expect(result.templates).toMatchObject([{ id, name: 'Legacy version' }]);

    const reloaded = await session(kit, scanner.headers);
    expect(reloaded).toMatchObject({
      state: 'ready',
      event: { id: event.id },
      scanner: { mode: 'live', settings: { acceptAllTemplates: false } },
    });
    expect(reloaded.templates).toEqual([
      {
        id,
        name: 'Unapproved draft',
        style: 'generic',
        formats: ['pdf417'],
        actions: [{ id: 'draft_entry', label: 'Draft entry', kind: 'check_in' }],
      },
    ]);
  });
});
