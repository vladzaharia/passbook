import type {
  CreateTemplateCandidate,
  TemplateCandidate,
} from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createProjectionCandidate } from '../wallet-providers/projection-service.ts';
import { authorizeTemplateWrite, keysApplyOnly } from './access.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
  candidateHash as hashCandidate,
} from './release-content.ts';
import { currentPolicy, sealedDigest, snapshot } from './releases-candidate.ts';
import { scopedTemplate, toCandidate, writable } from './releases-domain.ts';
import { getVersion } from './repo.ts';
import { userNames } from './repo-release-names.ts';
import { releasedCandidateIds } from './repo-release-state.ts';
import { writeCandidate } from './repo-release-write.ts';
import { type CandidateRow, listApprovals, listCandidates } from './repo-releases.ts';

export type Envelope = Pick<
  CandidateRow,
  'version' | 'contentHash' | 'authorId' | 'versionAuthorId'
>;

/**
 * An unreleased candidate this one would duplicate: the same sealed envelope but for its creation
 * time, so the same author, version author, content and release policy.
 */
export async function reusable(
  ctx: ServiceContext,
  templateId: string,
  scope: CreateTemplateCandidate,
  want: Envelope,
): Promise<CandidateRow | null> {
  const db = ctx.env.DB;
  const [rows, released] = await Promise.all([
    listCandidates(db, { templateId, orgId: scope.orgId, mode: scope.mode, provider: 'apple' }),
    releasedCandidateIds(db, templateId, scope.orgId, scope.mode),
  ]);
  for (const c of rows)
    if (
      !released.has(c.id) &&
      c.version === want.version &&
      c.contentHash === want.contentHash &&
      c.authorId === want.authorId &&
      c.versionAuthorId === want.versionAuthorId &&
      currentPolicy(c) &&
      (await hashCandidate(snapshot(c))) === c.candidateHash
    )
      return c;
  return null;
}

export async function createCandidate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  body: CreateTemplateCandidate,
): Promise<TemplateCandidate> {
  keysApplyOnly(auth, body.provider);
  if (body.provider !== 'apple') return createProjectionCandidate(ctx, auth, templateId, body);
  if (body.sourceReleaseId !== undefined || body.projection !== undefined)
    throw new ValidationError('Apple candidates cannot contain projection fields.');
  const template = await scopedTemplate(ctx, auth, templateId, body);
  writable(template, body);
  const authority = await authorizeTemplateWrite(ctx, auth, body.orgId, 'templates:author');
  const version = await getVersion(ctx.env.DB, templateId, body.version);
  if (!version)
    throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  if (!version.report.ok)
    throw new ConflictError('The template version is invalid.', 'VERSION_INVALID');
  const hashes = await sealedDigest(ctx, version);
  const reused = await reusable(ctx, templateId, body, {
    version: version.version,
    contentHash: hashes.contentHash,
    authorId: authority.userId,
    versionAuthorId: version.createdBy,
  });
  if (reused) {
    const approvals = await listApprovals(ctx.env.DB, reused.id);
    const ids = [reused.authorId, reused.versionAuthorId, ...approvals.map((a) => a.reviewerId)];
    return toCandidate(reused, approvals, await userNames(ctx.env.DB, ids, body.orgId, false));
  }
  const now = ctx.clock.now();
  const candidate: CandidateRow = {
    id: ctx.ids.id(),
    templateId,
    orgId: body.orgId,
    mode: body.mode,
    provider: body.provider,
    version: version.version,
    contentHash: hashes.contentHash,
    candidateHash: '',
    adapterRevision: APPLE_ADAPTER_REVISION,
    adapterCapabilities: [...APPLE_ADAPTER_CAPABILITIES],
    audiencePolicyRevision: AUDIENCE_POLICY_REVISION,
    authorId: authority.userId,
    versionAuthorId: version.createdBy,
    createdAt: now,
  };
  candidate.candidateHash = await hashCandidate(snapshot(candidate));
  await writeCandidate(ctx, authority, candidate, hashes, {
    candidateId: candidate.id,
    version: candidate.version,
    mode: body.mode,
    provider: body.provider,
    candidateHash: candidate.candidateHash,
  });
  return toCandidate(
    candidate,
    [],
    await userNames(ctx.env.DB, [candidate.authorId, candidate.versionAuthorId], body.orgId, false),
  );
}
