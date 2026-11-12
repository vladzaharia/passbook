import { packedPredicate } from './repo-action-authority.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

/** Reserve a PIN only for this pending claim and its current authority snapshots. */
export function approvalReservationPredicate(
  scanId: string,
  claimAt: number,
  original: OutputPredicate,
  actorFence: OutputPredicate,
  csrf: OutputPredicate,
  tokens: OutputPredicate,
  template: OutputPredicate,
): OutputPredicate {
  return packedPredicate(
    `EXISTS (SELECT 1 FROM scans WHERE scans.id=?/* scan-ephemeral-scan-id */
    AND scans.state='pending' AND scans.at=? AND (${original.sql})) AND (${actorFence.sql})
    AND (${csrf.sql}) AND (${tokens.sql}) AND (${template.sql})`,
    [
      scanId,
      claimAt,
      ...original.params,
      ...actorFence.params,
      ...csrf.params,
      ...tokens.params,
      ...template.params,
    ],
  );
}
