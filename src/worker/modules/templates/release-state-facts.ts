import type { Mode } from '../../../shared/contracts/common.ts';
import type { TemplateReleaseState } from '../../../shared/contracts/template-releases.ts';
import {
  type ReleaseFacts,
  type ReleaseHeadFact,
  type ReviewFact,
  releaseState,
} from '../../../shared/template-release-state.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError, UnauthenticatedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeTemplateWrite, type TemplateCapability } from './access.ts';
import {
  APPLE_ADAPTER_CAPABILITIES,
  APPLE_ADAPTER_REVISION,
  AUDIENCE_POLICY_REVISION,
} from './release-content.ts';
import type { VersionRow } from './repo.ts';
import { userNames } from './repo-release-names.ts';
import { isActiveReviewer, releasedCandidateIds } from './repo-release-state.ts';
import {
  type ApprovalRow,
  type CandidateRow,
  getActiveRelease,
  listApprovals,
  listCandidates,
  type ReleaseRow,
} from './repo-releases.ts';
import { countEligibleReviewers } from './repo-sole-reviewer.ts';
import { isPlatformAdmin } from './service-access.ts';

/** The member acting for `capability` here, or null when the caller lacks it. */
async function actorFor(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  orgId: string,
  capability: TemplateCapability,
): Promise<string | null> {
  try {
    return (await authorizeTemplateWrite(ctx, auth, orgId, capability)).userId;
  } catch (error) {
    // Why: a refusal is the answer here ("can't"), not a failure of the read.
    if (error instanceof ForbiddenError || error instanceof UnauthenticatedError) return null;
    throw error;
  }
}

// Why: `releases-candidate.ts` reaches `service.ts`, which reads this file; these mirror its
// `currentPolicy` and `approvalMatches` for a peer approval.
const current = (c: CandidateRow) =>
  c.adapterRevision === APPLE_ADAPTER_REVISION &&
  c.audiencePolicyRevision === AUDIENCE_POLICY_REVISION &&
  JSON.stringify(c.adapterCapabilities) === JSON.stringify(APPLE_ADAPTER_CAPABILITIES);
const independent = (a: ApprovalRow, c: CandidateRow) =>
  a.kind === 'peer' &&
  a.candidateHash === c.candidateHash &&
  a.reviewerId !== c.authorId &&
  a.reviewerId !== c.versionAuthorId;

async function liveReviews(
  ctx: ServiceContext,
  templateId: string,
  orgId: string,
): Promise<(ReviewFact & { reviewerId: string | null })[]> {
  const db = ctx.env.DB;
  const scope = { templateId, orgId, mode: 'live' as const, provider: 'apple' as const };
  const [candidates, released] = await Promise.all([
    listCandidates(db, scope),
    releasedCandidateIds(db, templateId, orgId, 'live'),
  ]);
  const open = candidates.filter((c) => !released.has(c.id) && current(c));
  return Promise.all(
    open.map(async (c) => {
      const peer = (await listApprovals(db, c.id)).find((a) => independent(a, c));
      return {
        version: c.version,
        authorId: c.authorId,
        authorName: null,
        at: c.createdAt,
        reviewerId: peer?.reviewerId ?? null,
        approval: peer ? { reviewerName: null, at: peer.createdAt } : null,
      };
    }),
  );
}

/** Builds the release facts of an org-owned (or shared) uploaded template for this caller. */
export async function loadReleaseFacts(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  orgId: string,
  versions: readonly VersionRow[],
): Promise<ReleaseFacts> {
  const db = ctx.env.DB;
  const head = (mode: Mode) => getActiveRelease(db, { templateId, orgId, mode, provider: 'apple' });
  const [author, review, publish, live, test, reviews, count] = await Promise.all([
    actorFor(ctx, auth, orgId, 'templates:author'),
    actorFor(ctx, auth, orgId, 'templates:review'),
    actorFor(ctx, auth, orgId, 'templates:publish'),
    head('live'),
    head('test'),
    liveReviews(ctx, templateId, orgId),
    countEligibleReviewers(db, orgId),
  ]);
  const userId = author ?? review ?? publish ?? (auth?.kind === 'session' ? auth.userId : null);
  const names = await userNames(
    db,
    [live?.createdBy ?? null, ...reviews.flatMap((r) => [r.authorId, r.reviewerId])],
    orgId,
    isPlatformAdmin(auth),
  );
  const name = (id: string | null) => (id === null ? null : (names.get(id) ?? null));
  const headFact = (row: ReleaseRow | null): ReleaseHeadFact | null =>
    row && { version: row.version, at: row.createdAt, byName: name(row.createdBy) };
  return {
    versions: versions.map((v) => ({
      version: v.version,
      at: v.createdAt,
      ok: v.report.ok,
      by: v.createdBy,
    })),
    live: headFact(live),
    test: headFact(test),
    reviews: reviews.map(({ reviewerId, ...r }) => ({
      ...r,
      authorName: name(r.authorId),
      approval: r.approval && { ...r.approval, reviewerName: name(reviewerId) },
    })),
    caller: { userId, author: author !== null, review: review !== null, publish: publish !== null },
    reviewers: {
      count,
      includesCaller: userId !== null && (await isActiveReviewer(db, orgId, userId)),
    },
  };
}

export async function loadReleaseState(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  templateId: string,
  orgId: string,
  versions: readonly VersionRow[],
): Promise<TemplateReleaseState> {
  return releaseState(await loadReleaseFacts(ctx, auth, templateId, orgId, versions));
}
