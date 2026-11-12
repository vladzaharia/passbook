import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { OrgInvitation, OrgMembership } from '../src/shared/contracts/org-membership.ts';
import type { PassDetailDto } from '../src/shared/contracts/passes.ts';
import type { SessionResponse } from '../src/shared/contracts/session.ts';
import { SaveVersionResponseSchema } from '../src/shared/contracts/template-versions.ts';
import {
  TemplateDetailSchema,
  TemplateVersionDetailSchema,
} from '../src/shared/contracts/templates.ts';
import {
  apiAs,
  BASE,
  createPass,
  GENERIC,
  requireActiveTemplateRelease,
  templateReleases,
  uid,
} from './helpers/api.ts';
import {
  approveTemplateCandidate,
  createTemplateCandidate,
  publishTemplateCandidate,
  rollbackTemplateRelease,
  templateReviewer,
} from './helpers/releases.ts';
import { createOrgWithRoles } from './helpers/seed.ts';

test.setTimeout(120_000);

test('releases require independent review, compare-and-swap, and mode-specific issuance', async () => {
  const author = await apiAs('admin');
  try {
    const authorSession = await author.get<SessionResponse>('/api/v1/session');
    expect(authorSession.authenticated).toBe(true);
    if (!authorSession.authenticated) throw new Error('Expected an authenticated author');
    const slug = uid('release-e2e').toLowerCase();
    const org = await createOrgWithRoles(author, { slug, name: `Release test ${slug}` });
    const clone = TemplateDetailSchema.parse(
      await author.send('POST', `/api/v1/templates/${encodeURIComponent(GENERIC)}/clone`, {
        orgId: org.id,
        name: uid('Reviewed template'),
      }),
    );
    expect(clone).toMatchObject({ orgId: org.id, origin: 'uploaded', activeVersion: null });
    expect(clone.versions).toHaveLength(1);
    const initialVersion = clone.versions[0];
    if (!initialVersion) throw new Error('The cloned template has no immutable version');
    expect(initialVersion).toMatchObject({ active: false, createdBy: authorSession.user.id });
    const version = initialVersion.version;
    expect(version).not.toBe('');

    const templatePath = `/api/v1/templates/${encodeURIComponent(clone.id)}`;
    const passListPath = `/api/v1/passes?orgId=${encodeURIComponent(org.id)}`;
    const headers = { Origin: BASE, 'X-CSRF-Token': authorSession.csrfToken };
    const listPasses = (mode: 'live' | 'test') =>
      author.send<{ items: { id: string }[]; nextCursor: string | null }>(
        'GET',
        passListPath,
        undefined,
        { 'x-passbook-mode': mode },
      );
    expect(await templateReleases(author, org.id, clone.id, 'live')).toEqual({
      active: null,
      items: [],
    });
    expect(await templateReleases(author, org.id, clone.id, 'test')).toEqual({
      active: null,
      items: [],
    });
    expect(await listPasses('live')).toMatchObject({ items: [], nextCursor: null });

    // A syntactically valid pin cannot turn an unpublished draft into an issuable release.
    const noRelease = await author.ctx.post('/api/v1/passes', {
      headers: { ...headers, 'x-passbook-mode': 'live', 'Idempotency-Key': uid('no-release') },
      data: {
        orgId: org.id,
        templateId: clone.id,
        templateVersion: version,
        releaseId: randomUUID(),
        releaseGeneration: 1,
        mode: 'live',
        input: { holder: uid('Unpublished holder'), memberId: uid('ID').toUpperCase() },
      },
    });
    expect(noRelease.status()).toBe(409);
    expect(await noRelease.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
    expect(await listPasses('live')).toMatchObject({ items: [], nextCursor: null });
    expect(await listPasses('test')).toMatchObject({ items: [], nextCursor: null });

    const reviewer = await templateReviewer(author, org.id);
    try {
      const reviewerSession = await reviewer.get<SessionResponse>('/api/v1/session');
      expect(reviewerSession.authenticated).toBe(true);
      if (!reviewerSession.authenticated) throw new Error('Expected an authenticated reviewer');
      expect(reviewerSession.user.id).not.toBe(authorSession.user.id);
      const memberships = await reviewer.get<{ items: OrgMembership[] }>(
        '/api/v1/orgs/memberships/me',
      );
      expect(memberships.items.filter((item) => item.orgId === org.id)).toEqual([
        expect.objectContaining({
          userId: reviewerSession.user.id,
          roles: ['template_reviewer'],
          capabilities: expect.arrayContaining(['templates:review']),
          revokedAt: null,
        }),
      ]);
      const invitations = await author.get<{ items: OrgInvitation[] }>(
        `/api/v1/orgs/${encodeURIComponent(org.id)}/invitations`,
      );
      expect(invitations.items).toContainEqual(
        expect.objectContaining({
          email: reviewerSession.user.primaryEmail.toLowerCase(),
          roles: ['template_reviewer'],
          acceptedAt: expect.any(Number),
          revokedAt: null,
        }),
      );

      const liveCandidate = await createTemplateCandidate(
        author,
        org.id,
        clone.id,
        version,
        'live',
      );
      expect(liveCandidate).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'live',
        provider: 'apple',
        version,
        authorId: authorSession.user.id,
        versionAuthorId: authorSession.user.id,
      });
      expect(liveCandidate.id).not.toBe('');
      expect(liveCandidate.candidateHash).toMatch(/^[0-9a-f]{64}$/);
      const selfApproval = await author.ctx.post(
        `${templatePath}/candidates/${encodeURIComponent(liveCandidate.id)}/approve`,
        {
          headers: { ...headers, 'x-passbook-mode': 'live' },
          data: {
            orgId: org.id,
            mode: 'live',
            provider: 'apple',
            candidateHash: liveCandidate.candidateHash,
          },
        },
      );
      expect(selfApproval.status()).toBe(403);
      expect(await selfApproval.json()).toMatchObject({ code: 'TEMPLATE_SELF_APPROVAL' });
      expect((await templateReleases(author, org.id, clone.id, 'live')).active).toBeNull();

      const liveApproval = await approveTemplateCandidate(reviewer, liveCandidate);
      expect(liveApproval).toMatchObject({
        candidateId: liveCandidate.id,
        candidateHash: liveCandidate.candidateHash,
        reviewerId: reviewerSession.user.id,
      });
      expect(liveApproval.id).not.toBe('');
      expect(liveApproval.reviewerId).not.toBe(liveCandidate.authorId);
      expect(liveApproval.reviewerId).not.toBe(liveCandidate.versionAuthorId);
      const liveRelease = await publishTemplateCandidate(author, liveCandidate, liveApproval, 0);
      expect(liveRelease).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'live',
        provider: 'apple',
        version,
        generation: 1,
        source: 'approved',
        action: 'release',
        candidateId: liveCandidate.id,
        approvalId: liveApproval.id,
        candidateHash: liveCandidate.candidateHash,
        previousReleaseId: null,
      });
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'live')).toEqual(
        liveRelease,
      );
      const liveHolder = uid('Live holder');
      const liveMemberId = uid('LIVE').toUpperCase();
      const livePass = (await createPass(author, org.id, {
        templateId: clone.id,
        release: liveRelease,
        mode: 'live',
        holder: liveHolder,
        memberId: liveMemberId,
      })) as PassDetailDto;
      expect(livePass).toMatchObject({
        id: expect.any(String),
        orgId: org.id,
        templateId: clone.id,
        templateVersion: version,
        mode: 'live',
        status: 'active',
        personalization: { holder: liveHolder, memberId: liveMemberId },
      });
      expect(livePass.id).not.toBe('');
      expect((await listPasses('live')).items).toEqual([
        expect.objectContaining({ id: livePass.id }),
      ]);
      expect(await templateReleases(author, org.id, clone.id, 'test')).toEqual({
        active: null,
        items: [],
      });

      // The same immutable content needs its own approval and release in Test mode.
      const testCandidate = await createTemplateCandidate(
        author,
        org.id,
        clone.id,
        version,
        'test',
      );
      expect(testCandidate).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'test',
        provider: 'apple',
        version,
        authorId: authorSession.user.id,
        versionAuthorId: authorSession.user.id,
      });
      expect(testCandidate.id).not.toBe(liveCandidate.id);
      const testApproval = await approveTemplateCandidate(reviewer, testCandidate);
      expect(testApproval).toMatchObject({
        candidateId: testCandidate.id,
        candidateHash: testCandidate.candidateHash,
        reviewerId: reviewerSession.user.id,
      });
      expect(testApproval.id).not.toBe(liveApproval.id);
      expect(testApproval.reviewerId).not.toBe(testCandidate.authorId);
      expect(testApproval.reviewerId).not.toBe(testCandidate.versionAuthorId);
      const testRelease = await publishTemplateCandidate(author, testCandidate, testApproval, 0);
      expect(testRelease).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'test',
        provider: 'apple',
        version,
        generation: 1,
        source: 'approved',
        action: 'release',
        candidateId: testCandidate.id,
        approvalId: testApproval.id,
        candidateHash: testCandidate.candidateHash,
        previousReleaseId: null,
      });
      expect(testRelease.id).not.toBe(liveRelease.id);
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'test')).toEqual(
        testRelease,
      );
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'live')).toEqual(
        liveRelease,
      );

      const testInput = { holder: uid('Test holder'), memberId: uid('TEST').toUpperCase() };
      const testIssue = {
        orgId: org.id,
        templateId: clone.id,
        templateVersion: version,
        releaseId: testRelease.id,
        releaseGeneration: testRelease.generation,
        mode: 'test',
        input: testInput,
      };
      // Both heads have the same version and generation; only the release ID is from Live.
      const wrongModePin = await author.ctx.post('/api/v1/passes', {
        headers: { ...headers, 'x-passbook-mode': 'test', 'Idempotency-Key': uid('wrong-mode') },
        data: { ...testIssue, releaseId: liveRelease.id },
      });
      expect(wrongModePin.status()).toBe(409);
      expect(await wrongModePin.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      expect(await listPasses('test')).toMatchObject({ items: [], nextCursor: null });
      const testCreated = await author.ctx.post('/api/v1/passes', {
        headers: { ...headers, 'x-passbook-mode': 'test', 'Idempotency-Key': uid('test-issue') },
        data: testIssue,
      });
      expect(testCreated.status()).toBe(201);
      const testPass = (await testCreated.json()) as PassDetailDto;
      expect(testPass).toMatchObject({
        id: expect.any(String),
        orgId: org.id,
        templateId: clone.id,
        templateVersion: version,
        mode: 'test',
        status: 'active',
        personalization: testInput,
      });
      expect(testPass.id).not.toBe('');
      expect(testPass.id).not.toBe(livePass.id);
      expect((await listPasses('test')).items).toEqual([
        expect.objectContaining({ id: testPass.id }),
      ]);
      expect((await listPasses('live')).items).toEqual([
        expect.objectContaining({ id: livePass.id }),
      ]);

      // Save a different immutable version so the CAS and rollback move a real version pointer.
      const versionDetail = TemplateVersionDetailSchema.parse(
        await author.get(`${templatePath}/versions/${encodeURIComponent(version)}`),
      );
      const saved = SaveVersionResponseSchema.parse(
        await author.send('POST', `${templatePath}/versions`, {
          manifest: versionDetail.manifest,
          passJson: { ...versionDetail.passJson, description: 'Second reviewed release' },
          assets: versionDetail.assets.map(({ name, sha1 }) => ({ name, sha1 })),
        }),
      );
      expect(saved).toMatchObject({ saved: true, created: true });
      const secondVersion = saved.version;
      if (!secondVersion) throw new Error('Saving the second immutable version failed');
      expect(secondVersion).not.toBe(version);
      expect(saved.template?.activeVersion).toBe(version);
      const nextCandidate = await createTemplateCandidate(
        author,
        org.id,
        clone.id,
        secondVersion,
        'live',
      );
      expect(nextCandidate).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        version: secondVersion,
        mode: 'live',
        authorId: authorSession.user.id,
        versionAuthorId: authorSession.user.id,
      });
      expect(nextCandidate.id).not.toBe(liveCandidate.id);
      const nextApproval = await approveTemplateCandidate(reviewer, nextCandidate);
      expect(nextApproval).toMatchObject({
        candidateId: nextCandidate.id,
        candidateHash: nextCandidate.candidateHash,
        reviewerId: reviewerSession.user.id,
      });
      expect(nextApproval.reviewerId).not.toBe(nextCandidate.authorId);
      expect(nextApproval.reviewerId).not.toBe(nextCandidate.versionAuthorId);
      const beforeStale = await templateReleases(author, org.id, clone.id, 'live');
      expect(beforeStale.active).toEqual(liveRelease);
      expect(beforeStale.items).toHaveLength(1);
      const stale = await author.ctx.post(`${templatePath}/releases`, {
        headers: { ...headers, 'x-passbook-mode': 'live' },
        data: {
          orgId: org.id,
          mode: 'live',
          provider: 'apple',
          candidateId: nextCandidate.id,
          approvalId: nextApproval.id,
          candidateHash: nextCandidate.candidateHash,
          expectedGeneration: 0,
        },
      });
      expect(stale.status()).toBe(409);
      expect(await stale.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
      expect(await templateReleases(author, org.id, clone.id, 'live')).toEqual(beforeStale);
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'test')).toEqual(
        testRelease,
      );

      const nextRelease = await publishTemplateCandidate(
        author,
        nextCandidate,
        nextApproval,
        liveRelease.generation,
      );
      expect(nextRelease).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'live',
        version: secondVersion,
        generation: liveRelease.generation + 1,
        source: 'approved',
        action: 'release',
        candidateId: nextCandidate.id,
        approvalId: nextApproval.id,
        candidateHash: nextCandidate.candidateHash,
        previousReleaseId: liveRelease.id,
      });
      expect(nextRelease.id).not.toBe(liveRelease.id);
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'live')).toEqual(
        nextRelease,
      );
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'test')).toEqual(
        testRelease,
      );
      const updatedTemplate = TemplateDetailSchema.parse(await author.get(templatePath));
      expect(updatedTemplate.activeVersion).toBe(secondVersion);

      // The current version alone is insufficient: both the release ID and generation are pinned.
      const liveIdsBeforeStalePin = (await listPasses('live')).items.map(({ id }) => id).sort();
      const currentInput = {
        holder: uid('Current holder'),
        memberId: uid('CURRENT').toUpperCase(),
      };
      for (const pin of [
        { releaseId: liveRelease.id, releaseGeneration: nextRelease.generation },
        { releaseId: nextRelease.id, releaseGeneration: liveRelease.generation },
      ]) {
        const stalePin = await author.ctx.post('/api/v1/passes', {
          headers: { ...headers, 'x-passbook-mode': 'live', 'Idempotency-Key': uid('stale-pin') },
          data: {
            orgId: org.id,
            templateId: clone.id,
            templateVersion: secondVersion,
            ...pin,
            mode: 'live',
            input: currentInput,
          },
        });
        expect(stalePin.status()).toBe(409);
        expect(await stalePin.json()).toMatchObject({ code: 'TEMPLATE_RELEASE_CONFLICT' });
        expect((await listPasses('live')).items.map(({ id }) => id).sort()).toEqual(
          liveIdsBeforeStalePin,
        );
      }
      const currentPass = (await createPass(author, org.id, {
        templateId: clone.id,
        release: nextRelease,
        mode: 'live',
        holder: currentInput.holder,
        memberId: currentInput.memberId,
      })) as PassDetailDto;
      expect(currentPass).toMatchObject({
        orgId: org.id,
        templateId: clone.id,
        templateVersion: secondVersion,
        mode: 'live',
        status: 'active',
        personalization: currentInput,
      });
      expect(currentPass.id).not.toBe(livePass.id);

      const rolledBack = await rollbackTemplateRelease(
        author,
        liveRelease,
        nextRelease.generation,
        'Restore the first reviewed version',
      );
      expect(rolledBack).toMatchObject({
        templateId: clone.id,
        orgId: org.id,
        mode: 'live',
        version,
        generation: nextRelease.generation + 1,
        source: 'approved',
        action: 'rollback',
        candidateId: liveCandidate.id,
        approvalId: liveApproval.id,
        candidateHash: liveCandidate.candidateHash,
        previousReleaseId: nextRelease.id,
      });
      expect(rolledBack.id).not.toBe(liveRelease.id);
      expect(rolledBack.id).not.toBe(nextRelease.id);
      const afterRollback = await templateReleases(author, org.id, clone.id, 'live');
      expect(afterRollback.active).toEqual(rolledBack);
      expect(afterRollback.items).toHaveLength(3);
      expect(
        afterRollback.items.map((release) => release.generation).sort((a, b) => a - b),
      ).toEqual([1, 2, 3]);
      expect(afterRollback.items.map((release) => release.id)).toEqual(
        expect.arrayContaining([liveRelease.id, nextRelease.id, rolledBack.id]),
      );
      expect(await requireActiveTemplateRelease(author, org.id, clone.id, 'test')).toEqual(
        testRelease,
      );
      const restoredTemplate = TemplateDetailSchema.parse(await author.get(templatePath));
      expect(restoredTemplate.activeVersion).toBe(version);
    } finally {
      await reviewer.dispose();
    }
  } finally {
    await author.dispose();
  }
});
