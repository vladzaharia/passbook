import type { Grant } from '../../platform/authority.ts';
import { type GrantCond, tenantSql } from '../../platform/authority-cond.ts';
import { type GrantPart, writePart } from '../../platform/authority-include.ts';
import { RACE_RETENTION_PROOF } from './race-tags.ts';
import { scanRetentionExcludedSql } from './repo-scan-retention.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';
import { proofKind } from './scan-retention-proof-data.ts';

/**
 * The proof row, written in the grant's batch after the scan row and its ledger event. It is built from
 * those two rows (the batch's own writes): the event is this scan's, unique, and the scan closed with
 * the outcome the proof was signed for. The pass the reference was signed over, the event's stored
 * fields and the scan's actors are compared too: verification recomputes the scan digest but not the
 * event digest or the pass reference, and some readers trust a proof row without verifying it.
 */
export function retentionProofPart(prepared: PreparedScanRetentionProof): GrantPart {
  const { proof, scan, event } = prepared;
  // The kinds without a scanner action are bound to every fact that decides the kind or feeds the digest.
  const system = proofKind(scan) !== null;
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
      AND s.pass_version IS ? AND e.kind=? AND e.at=?${
        system
          ? ` AND json(json_object('t',s.actor_type,'i',s.actor_id,'u',s.undoes,'o',s.out_cause,'d',s.direction,
        'm',s.method,'k',s.action_kind,'p',s.template_id,'e',s.event_id,'s',s.presence_scope))=json(?)`
          : ''
      }
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
      ...(system
        ? [
            JSON.stringify({
              t: scan.actorType,
              i: scan.actorId,
              u: scan.undoes,
              o: scan.outCause ?? null,
              d: scan.direction,
              m: scan.method,
              k: scan.actionKind,
              p: scan.templateId,
              e: scan.eventId,
              s: scan.presenceScope,
            }),
          ]
        : []),
    ],
    RACE_RETENTION_PROOF,
  );
}

/**
 * The proof of an auto exit, desk mark-out or undo. Once the scan is done (`when`) the proof must exist:
 * a row the proof does not match aborts the batch (`SCAN_PROOF_MISMATCH`, 500) instead of committing without evidence.
 */
export function includeSystemRetentionProof(
  g: Grant,
  prepared: PreparedScanRetentionProof,
  when: GrantCond[] = [],
): void {
  g.include(retentionProofPart(prepared));
  g.assert(
    'proof',
    [
      tenantSql(
        'EXISTS (SELECT 1 FROM scan_retention_proofs r WHERE r.scan_id = ? AND r.org_id = {org} AND r.mode = {mode})',
        [prepared.scan.id],
      ),
    ],
    { when },
  );
}
