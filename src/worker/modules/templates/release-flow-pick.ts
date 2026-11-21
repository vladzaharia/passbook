import type { Mode } from '../../../shared/contracts/common.ts';
import type { ReleaseTemplate } from '../../../shared/contracts/template-releases.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { candidateHash as hashCandidate } from './release-content.ts';
import { approvalMatches, currentPolicy, snapshot } from './releases-candidate.ts';
import type { VersionRow } from './repo.ts';
import { releasedCandidateIds } from './repo-release-state.ts';
import {
  type ApprovalRow,
  type CandidateRow,
  listApprovals,
  listCandidates,
} from './repo-releases.ts';
import { reviewerAddedSince } from './repo-sole-reviewer.ts';

export interface Prepared {
  auth: AuthContext;
  orgId: string;
  templateId: string;
  version: VersionRow;
  contentHash: string;
  /** Test first, then Live. */
  modes: Mode[];
  request: boolean;
  expected: NonNullable<ReleaseTemplate['expected']>;
  userId: string;
  alone: boolean;
  canReview: boolean;
}

export interface Picked {
  candidate: CandidateRow;
  approval: ApprovalRow | null;
}

/**
 * An approval of this candidate the caller may publish with in `mode`. A `sole` approval holds only
 * while the caller is still alone and no reviewer joined since (the release trigger checks both).
 */
export async function usableApproval(
  ctx: ServiceContext,
  p: Prepared,
  mode: Mode,
  candidate: CandidateRow,
  approvals: readonly ApprovalRow[],
): Promise<ApprovalRow | null> {
  for (const a of approvals) {
    if (!approvalMatches(a, candidate)) continue;
    if (a.kind === 'peer') return a;
    if (a.reviewerId !== p.userId) continue;
    if (a.kind === 'test' && mode === 'test') return a;
    if (
      a.kind === 'sole' &&
      mode === 'live' &&
      p.alone &&
      !(await reviewerAddedSince(ctx.env.DB, p.orgId, a.createdAt))
    )
      return a;
  }
  return null;
}

/**
 * The candidate a release of this version in `mode` should use: any unreleased one for the same
 * content and policy that already has a usable approval (another author's included), else the
 * caller's own, oldest first so racing calls settle on the same one.
 */
export async function pickCandidate(
  ctx: ServiceContext,
  p: Prepared,
  mode: Mode,
): Promise<Picked | null> {
  const db = ctx.env.DB;
  const scope = { templateId: p.templateId, orgId: p.orgId, mode, provider: 'apple' as const };
  const [rows, released] = await Promise.all([
    listCandidates(db, scope),
    releasedCandidateIds(db, p.templateId, p.orgId, mode),
  ]);
  const open: CandidateRow[] = [];
  for (const c of [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)))
    if (
      !released.has(c.id) &&
      c.version === p.version.version &&
      c.contentHash === p.contentHash &&
      currentPolicy(c) &&
      (await hashCandidate(snapshot(c))) === c.candidateHash
    )
      open.push(c);
  for (const candidate of open) {
    const approval = await usableApproval(
      ctx,
      p,
      mode,
      candidate,
      await listApprovals(db, candidate.id),
    );
    if (approval) return { candidate, approval };
  }
  const own = open.find(
    (c) => c.authorId === p.userId && c.versionAuthorId === p.version.createdBy,
  );
  return own ? { candidate: own, approval: null } : null;
}
