import type { Mode } from '../../../shared/contracts/common.ts';
import type {
  TemplateRelease,
  TemplateReleaseProvider,
} from '../../../shared/contracts/template-releases.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { candidateHash as hashCandidate } from './release-content.ts';
import {
  approvalMatches,
  contentChanged,
  currentPolicy,
  verifyCandidate,
  verifyStoredContent,
} from './releases-candidate.ts';
import { sameScope, supported, toRelease } from './releases-domain.ts';
import { getTemplate, getVersion } from './repo.ts';
import { getActiveRelease, getApproval, getCandidate } from './repo-releases.ts';
import { syncBakedTemplates } from './sync.ts';

export async function activeAppleRelease(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
  mode: Mode,
  provider: TemplateReleaseProvider,
): Promise<TemplateRelease | null> {
  supported(provider);
  let template = await getTemplate(ctx.env.DB, templateId);
  if (!template || template.origin === 'baked') {
    await syncBakedTemplates(ctx);
    template = await getTemplate(ctx.env.DB, templateId);
  }
  if (template?.status !== 'active' || (template.orgId !== null && template.orgId !== orgId))
    return null;
  // The head query already applies org-over-platform precedence and the baked fallback.
  let row = await getActiveRelease(ctx.env.DB, { templateId, orgId, mode, provider });
  // Historical releases from a previous organization assignment are not eligible heads.
  if (
    row &&
    ((row.source === 'system' && row.orgId !== template.orgId) ||
      (row.source !== 'system' &&
        (row.orgId !== orgId || (template.orgId !== null && template.orgId !== orgId))))
  )
    row = null;
  if (
    !row ||
    row.templateId !== templateId ||
    row.mode !== mode ||
    row.provider !== provider ||
    !currentPolicy(row)
  )
    return null;
  if (row.source === 'system') {
    if (
      template.origin !== 'baked' ||
      row.orgId !== template.orgId ||
      row.action !== 'system' ||
      row.candidateId !== null ||
      row.approvalId !== null ||
      row.version !== template.activeVersion
    )
      return null;
    const version = await getVersion(ctx.env.DB, templateId, row.version);
    if (!version) throw contentChanged();
    await verifyStoredContent(ctx, version, row.contentHash);
    const digest = await hashCandidate({
      templateId,
      orgId: row.orgId,
      mode,
      provider,
      version: row.version,
      contentHash: row.contentHash,
      adapterRevision: row.adapterRevision,
      adapterCapabilities: row.adapterCapabilities,
      audiencePolicyRevision: row.audiencePolicyRevision,
      authorId: null,
      versionAuthorId: null,
      createdAt: row.createdAt,
    });
    if (digest !== row.candidateHash) throw contentChanged();
  } else if (row.source === 'legacy') {
    // Grandfathered at cutover: no candidate or approval exists, and its hashes are provenance markers.
    if (
      template.origin !== 'uploaded' ||
      row.orgId !== orgId ||
      (template.orgId !== null && template.orgId !== orgId) ||
      row.action !== 'legacy' ||
      row.generation !== 1 ||
      row.candidateId !== null ||
      row.approvalId !== null ||
      row.previousReleaseId !== null ||
      row.version !== template.activeVersion
    )
      return null;
  } else {
    if (
      row.orgId !== orgId ||
      (template.orgId !== null && template.orgId !== orgId) ||
      (row.action !== 'release' && row.action !== 'rollback') ||
      !row.candidateId ||
      !row.approvalId
    )
      return null;
    const [candidate, approval] = await Promise.all([
      getCandidate(ctx.env.DB, row.candidateId),
      getApproval(ctx.env.DB, row.approvalId),
    ]);
    if (
      !candidate ||
      !approval ||
      !approvalMatches(approval, candidate) ||
      !sameScope(candidate, templateId, { orgId, mode, provider }) ||
      candidate.version !== row.version ||
      candidate.candidateHash !== row.candidateHash ||
      candidate.contentHash !== row.contentHash ||
      !currentPolicy(candidate)
    )
      return null;
    await verifyCandidate(ctx, candidate, false);
  }
  return toRelease(row);
}
