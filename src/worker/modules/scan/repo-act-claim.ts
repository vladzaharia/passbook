import { stmt } from '../../platform/db.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import type { Claim } from './repo-scans.ts';

/** Fail only the owned pending generation, preserving retryability when it stayed pristine. */
export function failPendingActionClaimStmt(
  db: D1Database,
  claim: Claim,
  claimAt: number,
  observedAmbiguous: boolean,
  pristine: OutputPredicate,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scans SET state='failed',
      reason=CASE WHEN ? OR NOT (${pristine.sql}) THEN 'stale' ELSE NULL END
    WHERE scans.id=?/* scan-ephemeral-scan-id */ AND scans.at=? AND scans.state='pending'
      AND scans.org_id=? AND scans.mode=? AND scans.scanner_id IS ?/* scan-ephemeral-scanner-id */
      AND scans.event_id IS ?/* scan-ephemeral-event-id */ AND scans.actor_type=?
      AND scans.actor_id=?/* scan-ephemeral-actor-id */ AND scans.actor_key=?/* scan-ephemeral-actor-key */
      AND scans.staff_id IS ?/* scan-ephemeral-staff-id */ AND scans.method=?
      AND scans.idempotency_key=?/* scan-ephemeral-idempotency-key */
      AND scans.request_hash=?/* scan-ephemeral-request-hash */ RETURNING id,reason`,
    [
      observedAmbiguous,
      ...pristine.params,
      claim.id,
      claimAt,
      claim.orgId,
      claim.mode,
      claim.scannerId,
      claim.eventId,
      claim.actorType,
      claim.actorId,
      claim.actorKey,
      claim.staffId,
      claim.method,
      claim.idempotencyKey,
      claim.requestHash,
    ],
  );
}
