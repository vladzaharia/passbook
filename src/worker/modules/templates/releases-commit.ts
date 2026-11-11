import type {
  TemplateRelease,
  TemplateReleaseScope,
} from '../../../shared/contracts/template-releases.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TemplateAuthority } from './access.ts';
import { stylesOf } from './package/slots.ts';
import { clearTemplateCache } from './registry.ts';
import { approvalMatches } from './releases-candidate.ts';
import { changed, repositoryScope, toRelease } from './releases-domain.ts';
import { getTemplate, getVersion } from './repo.ts';
import { userNames } from './repo-release-names.ts';
import { writeRelease } from './repo-release-write.ts';
import {
  type ApprovalRow,
  type CandidateRow,
  getLatestRelease,
  getRelease,
} from './repo-releases.ts';

export async function commitRelease(
  ctx: ServiceContext,
  authority: TemplateAuthority,
  candidate: CandidateRow,
  approval: ApprovalRow,
  scope: TemplateReleaseScope,
  expectedGeneration: number,
  action: 'release' | 'rollback',
  targetReleaseId: string | null,
  expectedStatus: 'active' | 'archived',
  reason: string | null,
): Promise<TemplateRelease> {
  if (!approvalMatches(approval, candidate)) throw changed();
  const db = ctx.env.DB;
  const head = await getLatestRelease(db, repositoryScope(candidate.templateId, scope));
  if ((head?.generation ?? 0) !== expectedGeneration) throw changed();
  const version = await getVersion(db, candidate.templateId, candidate.version);
  const template = await getTemplate(db, candidate.templateId);
  if (!version) throw changed();
  const templateMetadata = {
    name: version.manifest.name,
    description: version.manifest.description ?? null,
    styles: stylesOf(version.passJson),
  };
  const now = ctx.clock.now();
  const id = ctx.ids.id();
  const ownsTemplate = scope.mode === 'live' && template?.orgId === candidate.orgId;
  await writeRelease(
    ctx,
    authority,
    {
      id,
      candidate,
      approvalId: approval.id,
      expectedGeneration,
      expectedReleaseId: head?.id ?? null,
      targetReleaseId,
      action,
      expectedStatus,
      createdBy: authority.userId,
      createdAt: now,
      metadata: ownsTemplate ? templateMetadata : null,
    },
    {
      releaseId: id,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      mode: scope.mode,
      provider: scope.provider,
      generation: expectedGeneration + 1,
      targetReleaseId,
      ...(reason === null ? {} : { reason }),
    },
  );
  clearTemplateCache(ctx.env, candidate.templateId);
  const created = await getRelease(db, id);
  if (!created) throw new Error('Committed template release was not found.');
  return toRelease(created, await userNames(db, [created.createdBy]));
}
