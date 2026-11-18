import type { TemplateCandidate } from '@/shared/contracts/template-releases.ts';

/** Sole and Test approvals are the author's own, recorded and badged "Self-approved". */
export const selfApproved = (approval: { kind?: 'peer' | 'sole' | 'test' | undefined }) =>
  approval.kind === 'sole' || approval.kind === 'test';

/** A release must use an approval for this exact immutable candidate: independent, or self-approved. */
export function eligibleApproval(candidate: TemplateCandidate) {
  return candidate.approvals.find(
    (approval) =>
      approval.candidateId === candidate.id &&
      approval.candidateHash === candidate.candidateHash &&
      (selfApproved(approval) ||
        (approval.reviewerId !== candidate.authorId &&
          approval.reviewerId !== candidate.versionAuthorId)),
  );
}
