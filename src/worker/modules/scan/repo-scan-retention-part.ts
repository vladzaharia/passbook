import { type GrantPart, writePart } from '../../platform/authority-include.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';

/**
 * The proof row, written in the grant's batch after the scan row and its ledger event. It is built from
 * those two rows (the batch's own writes): the event is this scan's, unique, and the scan closed with
 * the outcome the proof was signed for. The pass the reference was signed over, the event's stored
 * fields and the scan's actors are compared too: verification recomputes the scan digest but not the
 * event digest or the pass reference, and some readers trust a proof row without verifying it.
 */
export function retentionProofPart(prepared: PreparedScanRetentionProof): GrantPart {
  const { proof, scan, event } = prepared;
  const linked = (alias: string) =>
    `(CASE WHEN json_valid(${alias}.data) THEN json_extract(${alias}.data,'$.scanId') END)=s.id`;
  return writePart(
    `INSERT INTO scan_retention_proofs
    (scan_id,org_id,mode,ledger_event_id,pass_ref,event_digest,scan_digest,gate_snapshot,presence_snapshot,mac)
    SELECT s.id, {org}, {mode}, e.id, ?, ?, ?, ?, ?, ?
    FROM scans s JOIN pass_events e ON e.id=? AND e.pass_id=s.pass_id
    WHERE s.id=? AND s.org_id={org} AND s.mode={mode} AND e.org_id={org} AND e.mode={mode}
      AND s.pass_id=? AND e.data=? AND e.device IS ? AND e.actor_type IS ? AND e.actor_id IS ?
      AND s.actor_key=? AND s.scanner_id IS ? AND s.staff_id IS ? AND s.approved_by IS ?
      AND s.state='done' AND s.outcome=? AND s.reason IS ? AND s.at=? AND s.action_id IS ?
      AND s.pass_version IS ? AND e.kind=? AND e.at=?
      AND NOT ${scanRetentionExcludedSql('s')} AND ${linked('e')}
      AND (SELECT count(*) FROM pass_events duplicate WHERE duplicate.pass_id=e.pass_id
        AND duplicate.org_id={org} AND duplicate.mode={mode} AND ${linked('duplicate')})=1
      AND {grant}`,
    [
      proof.passRef,
      proof.eventDigest,
      proof.scanDigest,
      proof.gateSnapshot,
      proof.presenceSnapshot,
      proof.mac,
      event.id,
      proof.scanId,
      event.pass_id,
      event.data,
      event.device,
      event.actor_type,
      event.actor_id,
      scan.actorKey,
      scan.scannerId,
      scan.staffId,
      scan.approvedBy,
      scan.outcome,
      scan.reason,
      scan.at,
      scan.actionId,
      scan.passVersion,
      event.kind,
      event.at,
    ],
  );
}
