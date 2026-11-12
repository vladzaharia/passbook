import type { OrgMembership } from '../../src/shared/contracts/org-membership.ts';
import {
  type Api,
  apiAs,
  type ReleaseMode,
  requireActiveTemplateRelease,
  type TemplateRelease,
  templateReleases,
} from './api.ts';
import { addOrgMember } from './seed.ts';

export interface TemplateCandidate {
  id: string;
  templateId: string;
  orgId: string;
  mode: ReleaseMode;
  provider: 'apple';
  version: string;
  candidateHash: string;
  authorId: string;
  versionAuthorId: string | null;
}

export interface TemplateApproval {
  id: string;
  candidateId: string;
  candidateHash: string;
  reviewerId: string;
}

const scope = (orgId: string, mode: ReleaseMode) => ({ orgId, mode, provider: 'apple' as const });
const modeHeaders = (mode: ReleaseMode) => ({ 'x-passbook-mode': mode });
const templatePath = (templateId: string) => `/api/v1/templates/${encodeURIComponent(templateId)}`;

/** Obtain a distinct, invited reviewer; the caller must dispose the returned client. */
export async function templateReviewer(admin: Api, orgId: string): Promise<Api> {
  const reviewer = await apiAs('reviewer');
  try {
    const [authorSession, reviewerSession, memberships] = await Promise.all([
      admin.get<{ user?: { id: string } }>('/api/v1/session'),
      reviewer.get<{ user?: { id: string } }>('/api/v1/session'),
      reviewer.get<{ items: OrgMembership[] }>('/api/v1/orgs/memberships/me'),
    ]);
    if (
      !authorSession.user?.id ||
      !reviewerSession.user?.id ||
      authorSession.user.id === reviewerSession.user.id
    ) {
      throw new Error('Template reviewer must be a different signed-in user from the author');
    }
    let membership = memberships.items.find(
      (item) => item.orgId === orgId && item.revokedAt === null,
    );
    if (!membership) membership = await addOrgMember(admin, orgId, reviewer, ['template_reviewer']);
    if (
      !membership.roles.includes('template_reviewer') ||
      !membership.capabilities.includes('templates:review')
    ) {
      throw new Error('The existing reviewer membership does not have the template_reviewer role');
    }
    return reviewer;
  } catch (error) {
    await reviewer.dispose();
    throw error;
  }
}

export async function createTemplateCandidate(
  author: Api,
  orgId: string,
  templateId: string,
  version: string,
  mode: ReleaseMode = 'live',
): Promise<TemplateCandidate> {
  return author.send(
    'POST',
    `${templatePath(templateId)}/candidates`,
    { ...scope(orgId, mode), version },
    modeHeaders(mode),
  );
}

export async function approveTemplateCandidate(
  reviewer: Api,
  candidate: TemplateCandidate,
): Promise<TemplateApproval> {
  return reviewer.send(
    'POST',
    `${templatePath(candidate.templateId)}/candidates/${encodeURIComponent(candidate.id)}/approve`,
    { ...scope(candidate.orgId, candidate.mode), candidateHash: candidate.candidateHash },
    modeHeaders(candidate.mode),
  );
}

export async function publishTemplateCandidate(
  author: Api,
  candidate: TemplateCandidate,
  approval: TemplateApproval,
  expectedGeneration: number,
): Promise<TemplateRelease> {
  return author.send(
    'POST',
    `${templatePath(candidate.templateId)}/releases`,
    {
      ...scope(candidate.orgId, candidate.mode),
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration,
    },
    modeHeaders(candidate.mode),
  );
}

/** Approve and publish this exact immutable version, using the current release generation. */
export async function publishTemplateVersion(
  author: Api,
  orgId: string,
  templateId: string,
  version: string,
  mode: ReleaseMode = 'live',
): Promise<TemplateRelease> {
  const reviewer = await templateReviewer(author, orgId);
  try {
    const candidate = await createTemplateCandidate(author, orgId, templateId, version, mode);
    const approval = await approveTemplateCandidate(reviewer, candidate);
    if (
      approval.candidateId !== candidate.id ||
      approval.candidateHash !== candidate.candidateHash ||
      approval.reviewerId === candidate.authorId ||
      approval.reviewerId === candidate.versionAuthorId
    ) {
      throw new Error('Candidate approval does not have distinct, matching reviewer provenance');
    }
    const { items } = await templateReleases(author, orgId, templateId, mode);
    const generation = items.reduce((latest, item) => Math.max(latest, item.generation), 0);
    const release = await publishTemplateCandidate(author, candidate, approval, generation);
    const active = await requireActiveTemplateRelease(author, orgId, templateId, mode);
    if (
      active.id !== release.id ||
      release.version !== version ||
      release.generation !== generation + 1 ||
      release.candidateId !== candidate.id ||
      release.approvalId !== approval.id
    ) {
      throw new Error('Published release is not the expected active candidate version');
    }
    return active;
  } finally {
    await reviewer.dispose();
  }
}

/** Restore a previously approved release, recording the required rollback reason. */
export async function rollbackTemplateRelease(
  author: Api,
  target: TemplateRelease,
  expectedGeneration: number,
  reason: string,
): Promise<TemplateRelease> {
  if (target.orgId === null || target.source !== 'approved') {
    throw new Error('Only an organization-approved release can be rolled back');
  }
  return author.send(
    'POST',
    `${templatePath(target.templateId)}/releases/rollback`,
    {
      ...scope(target.orgId, target.mode),
      releaseId: target.id,
      candidateHash: target.candidateHash,
      expectedGeneration,
      reason,
    },
    modeHeaders(target.mode),
  );
}
