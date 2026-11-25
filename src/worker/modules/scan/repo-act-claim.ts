import { run, stmt } from '../../platform/db.ts';
import type { Claim, PristineClaimFence } from './repo-scans.ts';

/** Fail only the owned pending generation, preserving retryability when it stayed pristine. */
export function failPendingActionClaimStmt(
  db: D1Database,
  claim: Claim,
  claimAt: number,
  observedAmbiguous: boolean,
  pristine: PristineClaimFence,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scans SET state='failed',
      reason=CASE WHEN ? OR NOT (${pristine.sql}) THEN 'stale' ELSE NULL END
    WHERE scans.id=? AND scans.at=? AND scans.state='pending'
      AND scans.org_id=? AND scans.mode=? AND scans.scanner_id IS ?
      AND scans.event_id IS ? AND scans.actor_type=?
      AND scans.actor_id=? AND scans.actor_key=?
      AND scans.staff_id IS ? AND scans.method=?
      AND scans.idempotency_key=?
      AND scans.request_hash=? RETURNING id,reason`,
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

/** Mark the scan a queued offline read produced: 1 on the list, 2 let in by staff with no list. Set once `act` finalized it. */
export const markScanOffline = (
  db: D1Database,
  scan: { id: string; orgId: string; mode: string },
  door: 'listed' | 'unverified',
) =>
  run(
    db,
    "UPDATE scans SET offline = ? WHERE id = ? AND org_id = ? AND mode = ? AND state = 'done' AND offline = 0",
    [door === 'unverified' ? 2 : 1, scan.id, scan.orgId, scan.mode],
  );
