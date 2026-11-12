import type { TemplateCandidate } from '@/shared/contracts/template-releases.ts';

/** A release must use an approval for this exact immutable candidate from a distinct reviewer. */
export function eligibleApproval(candidate: TemplateCandidate) {
  return candidate.approvals.find(
    (approval) =>
      approval.candidateId === candidate.id &&
      approval.candidateHash === candidate.candidateHash &&
      approval.reviewerId !== candidate.authorId &&
      approval.reviewerId !== candidate.versionAuthorId,
  );
}
