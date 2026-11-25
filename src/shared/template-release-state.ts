import type { TemplateReleaseState } from './contracts/template-release-flow.ts';

export interface ReleaseHeadFact {
  version: string;
  at: number;
  byName: string | null;
}

/** An unreleased Live candidate, with its newest independent (`peer`) approval. */
export interface ReviewFact {
  version: string;
  authorId: string;
  authorName: string | null;
  at: number;
  approval: { reviewerName: string | null; at: number } | null;
}

export interface ReleaseFacts {
  /** Every saved version, newest first. */
  versions: readonly { version: string; at: number; ok: boolean; by: string | null }[];
  live: ReleaseHeadFact | null;
  test: ReleaseHeadFact | null;
  /** Live candidates that are unreleased and on the current release policy. */
  reviews: readonly ReviewFact[];
  /** The acting member (a key acts as its creator) and the template capabilities they hold here. */
  caller: { userId: string | null; author: boolean; review: boolean; publish: boolean };
  /** The `sole` rule's inputs: active review-capable members, and whether the caller is one. */
  reviewers: { count: number; includesCaller: boolean };
}

/**
 * Mirrors `approvalKind` and the `template_approvals_insert` trigger: the caller is the org's only
 * review-capable member. They must also author and publish.
 */
export function isAlone(facts: Pick<ReleaseFacts, 'caller' | 'reviewers'>): boolean {
  const { caller, reviewers } = facts;
  return (
    caller.author &&
    caller.review &&
    caller.publish &&
    reviewers.count === 1 &&
    reviewers.includesCaller
  );
}

function reviewOf(
  draft: string | null,
  reviews: readonly ReviewFact[],
): TemplateReleaseState['review'] {
  if (draft === null) return { state: 'none' };
  const forDraft = reviews.filter((r) => r.version === draft);
  const approved = forDraft.find((r) => r.approval !== null);
  if (approved?.approval)
    return {
      state: 'approved',
      version: draft,
      by: approved.approval.reviewerName,
      at: approved.approval.at,
    };
  const open = forDraft.sort((a, b) => b.at - a.at)[0];
  return open
    ? { state: 'open', version: draft, by: open.authorName, at: open.at }
    : { state: 'none' };
}

export function releaseState(facts: ReleaseFacts): TemplateReleaseState {
  const { versions, live, test } = facts;
  const savedAt = (version: string) => versions.find((v) => v.version === version)?.at ?? 0;
  const newest = versions.find((v) => v.ok);
  const draft =
    newest &&
    newest.version !== live?.version &&
    (live === null || newest.at > savedAt(live.version))
      ? newest
      : null;
  const review = reviewOf(draft?.version ?? null, facts.reviews);
  const alone = isAlone(facts);
  const ahead =
    test !== null &&
    test.version !== live?.version &&
    (live === null || savedAt(test.version) > savedAt(live.version));
  return {
    live: live && { version: live.version, at: live.at, by: live.byName },
    test: test && { version: test.version, at: test.at, state: ahead ? 'ahead' : 'following' },
    draft: draft && { version: draft.version, at: draft.at },
    review,
    alone,
    next: nextOf(facts, draft, review, alone),
  };
}

function nextOf(
  facts: ReleaseFacts,
  draft: ReleaseFacts['versions'][number] | null,
  review: TemplateReleaseState['review'],
  alone: boolean,
): TemplateReleaseState['next'] {
  const { caller, live, test } = facts;
  if (!caller.author && !caller.review && !caller.publish) return null;
  if (!draft) return live === null && caller.author ? 'design' : null;
  const canTry = caller.author && caller.review && caller.publish;
  if (live === null && test?.version !== draft.version && canTry && review.state !== 'approved')
    return 'try';
  if (alone) return 'release';
  if (review.state === 'approved') return caller.publish ? 'release' : 'wait';
  if (review.state === 'open') {
    const authored =
      caller.userId !== null &&
      (caller.userId === draft.by ||
        facts.reviews.some((r) => r.version === draft.version && r.authorId === caller.userId));
    return caller.review && !authored ? 'review' : 'wait';
  }
  return caller.author ? 'request_review' : null;
}
