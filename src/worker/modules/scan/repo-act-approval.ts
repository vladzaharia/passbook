import type { ScanPredicate } from './scan-predicate.ts';

/** Reserve a PIN only for this pending claim, under the actor's authority and the pass the answer read. */
export function approvalReservationPredicate(
  scanId: string,
  claimAt: number,
  original: ScanPredicate,
  authority: ScanPredicate,
): ScanPredicate {
  return {
    sql: `EXISTS (SELECT 1 FROM scans WHERE scans.id = ? AND scans.state = 'pending' AND scans.at = ?
      AND (${original.sql})) AND (${authority.sql})`,
    params: [scanId, claimAt, ...original.params, ...authority.params],
    ...(authority.ctes ? { ctes: authority.ctes, cteParams: authority.cteParams ?? [] } : {}),
  };
}
