import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, placeholders, type SqlValue, stmt } from '../../platform/db.ts';
import { scanConjunction } from './repo-secret-binds.ts';
import {
  type PreparedScanRetentionDelete,
  type PreparedScanRetentionProof,
  type ScanRetentionSnapshot,
  verifyScanRetentionProof,
} from './scan-retention-proof.ts';

/** Trusted aliases only: a passless retained row must have an intact same-scope index. */
export function scanRetentionCandidateSql(scanAlias: string): string {
  return `(${scanAlias}.pass_id IS NULL AND EXISTS (SELECT 1 FROM scan_retention_proofs retention
    WHERE retention.scan_id=${scanAlias}.id AND retention.org_id=${scanAlias}.org_id
      AND retention.mode=${scanAlias}.mode AND retention.excluded=0 AND retention.invalidated=0)
    AND NOT ${scanRetentionExcludedSql(scanAlias)})`;
}

/** Includes damaged and cross-scope proofs, so they cannot masquerade as passless refusals. */
export function scanHasRetentionProofSql(scanAlias: string): string {
  return `EXISTS (SELECT 1 FROM scan_retention_proofs retention_any WHERE retention_any.scan_id=${scanAlias}.id)`;
}

/** Quarantine is separate from proof validity and also latches for pre-index scans. */
export function scanRetentionExcludedSql(scanAlias: string): string {
  return `(EXISTS (SELECT 1 FROM scan_quarantine_exclusions quarantine WHERE quarantine.scan_id=${scanAlias}.id)
    OR EXISTS (SELECT 1 FROM scan_retention_proofs retention_excluded
      WHERE retention_excluded.scan_id=${scanAlias}.id AND retention_excluded.excluded=1))`;
}

/** Count deleted passes by their opaque reference; all inputs are trusted SQL expressions. */
export function retainedEventCountSql(
  orgIdSql: string,
  modeSql: string,
  eventIdSql: string,
  inside: boolean,
): string {
  return `(SELECT count(DISTINCT retained_gate.pass_ref) FROM scan_retained_gates retained_gate
    JOIN scans retained_scan ON retained_scan.id=retained_gate.scan_id
      AND retained_scan.org_id=retained_gate.org_id AND retained_scan.mode=retained_gate.mode
      AND retained_scan.event_id=retained_gate.event_id AND retained_scan.pass_id IS NULL
    JOIN scan_retention_proofs retained_proof ON retained_proof.scan_id=retained_gate.scan_id
      AND retained_proof.org_id=retained_gate.org_id AND retained_proof.mode=retained_gate.mode
      AND retained_proof.pass_ref=retained_gate.pass_ref
      AND retained_proof.excluded=0 AND retained_proof.invalidated=0 AND retained_proof.occupancy_invalidated=0
    WHERE retained_gate.org_id=${orgIdSql} AND retained_gate.mode=${modeSql}
      AND retained_gate.event_id=${eventIdSql}
      AND NOT EXISTS (SELECT 1 FROM scan_quarantine_exclusions retained_quarantine
        WHERE retained_quarantine.scan_id=retained_gate.scan_id)
      ${inside ? "AND retained_gate.presence_state='in'" : ''})`;
}

// Source documents and potentially identifying fields must remain individual
// marked scalars when a surrounding authority predicate is packed.
function sourceParams(prepared: PreparedScanRetentionProof): SqlValue[] {
  const { pass_id: passId, actor_id: eventActorId, data: eventData, ...event } = prepared.event;
  const {
    actionId,
    actorId: scanActorId,
    actorKey,
    scannerId,
    staffId,
    approvedBy,
    ...scan
  } = prepared.scan;
  return [
    JSON.stringify({ proof: prepared.proof, scan, event }),
    passId,
    actionId,
    scanActorId,
    actorKey,
    eventActorId,
    eventData,
    scannerId,
    staffId,
    approvedBy,
  ];
}

// Both fences share this signed source; group comparisons for D1's expression limit.
const SOURCE_JOINS = `(SELECT json(?) AS j, ?/* scan-ephemeral-pass-id */ AS pass_id,
  ?/* scan-ephemeral-action-id */ AS action_id, ?/* scan-ephemeral-scan-actor */ AS scan_actor_id,
  ?/* scan-ephemeral-actor-key */ AS actor_key, ?/* scan-ephemeral-event-actor */ AS event_actor_id,
  ?/* scan-ephemeral-event-json */ AS event_data, ?/* scan-ephemeral-scanner-id */ AS scanner_id,
  ?/* scan-ephemeral-staff-id */ AS staff_id, ?/* scan-ephemeral-approver-id */ AS approved_by) input
  JOIN scans s ON s.id=json_extract(input.j,'$.proof.scanId')
  JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode AND p.test_data_quarantined=0
  JOIN pass_events e ON e.id=json_extract(input.j,'$.proof.ledgerEventId') AND e.pass_id=p.id
    AND e.org_id=s.org_id AND e.mode=s.mode`;
const SOURCE_MATCH = scanConjunction([
  `NOT ${scanRetentionExcludedSql('s')}`,
  `s.id=json_extract(input.j,'$.scan.id') AND s.org_id=json_extract(input.j,'$.scan.orgId')`,
  `s.mode=json_extract(input.j,'$.scan.mode') AND s.template_id IS json_extract(input.j,'$.scan.templateId')`,
  `s.scanner_id IS input.scanner_id AND s.event_id IS json_extract(input.j,'$.scan.eventId')`,
  `s.actor_type=json_extract(input.j,'$.scan.actorType') AND s.actor_id=input.scan_actor_id`,
  `s.actor_key=input.actor_key AND s.staff_id IS input.staff_id`,
  `s.approved_by IS input.approved_by AND s.method=json_extract(input.j,'$.scan.method')`,
  `s.state=json_extract(input.j,'$.scan.state') AND s.outcome=json_extract(input.j,'$.scan.outcome')`,
  `s.reason IS json_extract(input.j,'$.scan.reason') AND s.action_id IS input.action_id`,
  `s.action_kind IS json_extract(input.j,'$.scan.actionKind') AND s.direction IS json_extract(input.j,'$.scan.direction')`,
  `s.pass_version IS json_extract(input.j,'$.scan.passVersion')`,
  `s.presence_scope IS json_extract(input.j,'$.scan.presenceScope') AND s.at=json_extract(input.j,'$.scan.at')`,
  `s.undoes IS json_extract(input.j,'$.scan.undoes')`,
  `(s.override_of IS NOT NULL)=json_extract(input.j,'$.scan.override')`,
  `e.id=json_extract(input.j,'$.event.id') AND e.org_id=json_extract(input.j,'$.event.org_id')`,
  `e.pass_id=input.pass_id AND e.mode=json_extract(input.j,'$.event.mode')`,
  `e.kind=json_extract(input.j,'$.event.kind') AND e.device IS json_extract(input.j,'$.event.device')`,
  `e.actor_type IS json_extract(input.j,'$.event.actor_type') AND e.actor_id IS input.event_actor_id`,
  `e.data=input.event_data AND e.at=json_extract(input.j,'$.event.at')`,
  `(CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.scanId') END)=s.id`,
  `(SELECT count(*) FROM pass_events duplicate WHERE duplicate.pass_id=e.pass_id
    AND duplicate.org_id=e.org_id AND duplicate.mode=e.mode
    AND (CASE WHEN json_valid(duplicate.data) THEN json_extract(duplicate.data,'$.scanId') END)=s.id)=1`,
]);
const CURRENT_PROOF_MATCH = scanConjunction([
  SOURCE_MATCH,
  'r.excluded=0 AND r.invalidated=0',
  `r.org_id=json_extract(input.j,'$.proof.orgId') AND r.mode=json_extract(input.j,'$.proof.mode')`,
  `r.ledger_event_id=json_extract(input.j,'$.proof.ledgerEventId') AND r.pass_ref=json_extract(input.j,'$.proof.passRef')`,
  `r.event_digest=json_extract(input.j,'$.proof.eventDigest')`,
  `r.scan_digest=json_extract(input.j,'$.proof.scanDigest')`,
  `r.gate_snapshot IS json_extract(input.j,'$.proof.gateSnapshot')`,
  `r.presence_snapshot IS json_extract(input.j,'$.proof.presenceSnapshot')`,
  `r.mac=json_extract(input.j,'$.proof.mac')`,
]);

/**
 * Immediately follows the guarded event INSERT in the same transaction. Its `changes()`
 * fence, exact event/scan snapshot, current pass, and unique ledger linkage prevent a
 * partial or stale action from producing a trusted index. Follow it with the action's
 * existing completeness sentinel, which must abort when this INSERT did not succeed.
 */
export function retentionProofIfRecordedStmt(
  db: D1Database,
  prepared: PreparedScanRetentionProof,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO scan_retention_proofs
    (scan_id,org_id,mode,ledger_event_id,pass_ref,event_digest,scan_digest,gate_snapshot,presence_snapshot,mac)
    SELECT json_extract(input.j,'$.proof.scanId'), json_extract(input.j,'$.proof.orgId'),
      json_extract(input.j,'$.proof.mode'), json_extract(input.j,'$.proof.ledgerEventId'),
      json_extract(input.j,'$.proof.passRef'), json_extract(input.j,'$.proof.eventDigest'),
      json_extract(input.j,'$.proof.scanDigest'), json_extract(input.j,'$.proof.gateSnapshot'),
      json_extract(input.j,'$.proof.presenceSnapshot'), json_extract(input.j,'$.proof.mac')
    FROM ${SOURCE_JOINS} WHERE changes()=1 AND (${SOURCE_MATCH})`,
    sourceParams(prepared),
  );
}

/** Recheck the exact signed event, scan and immutable proof after asynchronous work. */
export function retentionProofCurrentPredicate(prepared: PreparedScanRetentionProof): {
  sql: string;
  params: SqlValue[];
} {
  return {
    sql: `EXISTS (SELECT 1 FROM ${SOURCE_JOINS}
      JOIN scan_retention_proofs r ON r.scan_id=s.id AND r.org_id=s.org_id AND r.mode=s.mode
      WHERE ${CURRENT_PROOF_MATCH})`,
    params: sourceParams(prepared),
  };
}

/** Stage only against a proven scan while the pass is still linked; store no pass id. */
export function stageScanRetentionDeleteStmt(
  db: D1Database,
  passId: string,
  prepared: PreparedScanRetentionDelete,
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT INTO scan_retention_delete_intents (scan_id,org_id,mode,pass_ref)
    SELECT s.id,s.org_id,s.mode,proof.pass_ref FROM scans s
    JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode
    JOIN scan_retention_proofs proof ON proof.scan_id=s.id AND proof.org_id=s.org_id
      AND proof.mode=s.mode AND proof.excluded=0 AND proof.invalidated=0
    WHERE s.pass_id=?/* scan-ephemeral-pass-id */ AND s.org_id=? AND s.mode=? AND proof.pass_ref=?
      AND p.test_data_quarantined=0 AND NOT ${scanRetentionExcludedSql('s')}
    ORDER BY s.at DESC,s.id DESC LIMIT 1`,
    [passId, prepared.orgId, prepared.mode, prepared.passRef],
  );
}

/** Always follow the conditional DELETE in the same D1 batch, including when it loses. */
export function clearScanRetentionDeleteStmt(
  db: D1Database,
  prepared: PreparedScanRetentionDelete,
): D1PreparedStatement {
  return stmt(
    db,
    'DELETE FROM scan_retention_delete_intents WHERE org_id=? AND mode=? AND pass_ref=?',
    [prepared.orgId, prepared.mode, prepared.passRef],
  );
}

/** Optional explicit latch, for a deletion transaction whose eligibility has already been fenced. */
export function excludeQuarantinedScanRetentionStmt(
  db: D1Database,
  passId: string,
  orgId: string,
  mode: Mode,
): D1PreparedStatement {
  return stmt(
    db,
    `UPDATE scan_retention_proofs SET excluded=1 WHERE excluded=0 AND scan_id IN (
    SELECT s.id FROM scans s JOIN passes p ON p.id=s.pass_id AND p.org_id=s.org_id AND p.mode=s.mode
    WHERE p.id=?/* scan-ephemeral-pass-id */ AND p.org_id=? AND p.mode=? AND p.test_data_quarantined=1
  )`,
    [passId, orgId, mode],
  );
}

interface Raw {
  proofScanId: string;
  proofOrgId: string;
  proofMode: Mode;
  ledgerEventId: string;
  passRef: string;
  eventDigest: string;
  scanDigest: string;
  gateSnapshot: string | null;
  presenceSnapshot: string | null;
  mac: string;
  excluded: number;
  invalidated: number;
  id: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  scannerId: string | null;
  eventId: string | null;
  actorType: 'scanner' | 'user';
  actorId: string;
  actorKey: string;
  staffId: string | null;
  approvedBy: string | null;
  method: ScanRetentionSnapshot['method'];
  state: 'done';
  outcome: ScanRetentionSnapshot['outcome'];
  reason: string | null;
  actionId: string | null;
  actionKind: string | null;
  direction: 'in' | 'out' | null;
  passVersion: number | null;
  presenceScope: string | null;
  at: number;
  undoes: string | null;
  override: number;
}

/**
 * Bounded reads and verification for richer per-row or direct-receipt disclosure.
 * The result is keyed only by scan ID and never exposes a deleted pass identity.
 * `{mode}` accepts a mixed-org platform scope; supplying orgId additionally fences it.
 */
export async function readVerifiedScanRetentionProofs(
  db: D1Database,
  env: object,
  scope: { orgId?: string; mode: Mode },
  scanIds: readonly string[],
): Promise<Map<string, { passRef: string }>> {
  const { orgId, mode } = scope;
  const out = new Map<string, { passRef: string }>();
  for (const ids of chunk([...new Set(scanIds)], 88)) {
    const rows = await all<Raw>(
      db,
      `SELECT
      r.scan_id AS proofScanId,r.org_id AS proofOrgId,r.mode AS proofMode,r.ledger_event_id AS ledgerEventId,
      r.pass_ref AS passRef,r.event_digest AS eventDigest,r.scan_digest AS scanDigest,
      r.gate_snapshot AS gateSnapshot,r.presence_snapshot AS presenceSnapshot,r.mac,r.excluded,r.invalidated,
      s.id,s.org_id AS orgId,s.mode,s.template_id AS templateId,s.scanner_id AS scannerId,s.event_id AS eventId,
      s.actor_type AS actorType,s.actor_id AS actorId,s.actor_key AS actorKey,s.staff_id AS staffId,
      s.approved_by AS approvedBy,s.method,s.state,s.outcome,s.reason,s.action_id AS actionId,
      s.action_kind AS actionKind,s.direction,s.pass_version AS passVersion,s.presence_scope AS presenceScope,
      s.at,s.undoes,(s.override_of IS NOT NULL) AS override
      FROM scans s JOIN scan_retention_proofs r ON r.scan_id=s.id
      WHERE s.id IN (${placeholders(ids.length)}) AND s.mode=?
        ${orgId === undefined ? '' : 'AND s.org_id=?'} AND ${scanRetentionCandidateSql('s')}`,
      [...ids, mode, ...(orgId === undefined ? [] : [orgId])],
    );
    const verified = await Promise.all(
      rows.map(async (row) => {
        const proof = {
          scanId: row.proofScanId,
          orgId: row.proofOrgId,
          mode: row.proofMode,
          ledgerEventId: row.ledgerEventId,
          passRef: row.passRef,
          eventDigest: row.eventDigest,
          scanDigest: row.scanDigest,
          gateSnapshot: row.gateSnapshot,
          presenceSnapshot: row.presenceSnapshot,
          mac: row.mac,
          excluded: row.excluded,
          invalidated: row.invalidated,
        };
        const scan = {
          id: row.id,
          orgId: row.orgId,
          mode: row.mode,
          templateId: row.templateId,
          scannerId: row.scannerId,
          eventId: row.eventId,
          actorType: row.actorType,
          actorId: row.actorId,
          actorKey: row.actorKey,
          staffId: row.staffId,
          approvedBy: row.approvedBy,
          method: row.method,
          state: row.state,
          outcome: row.outcome,
          reason: row.reason,
          actionId: row.actionId,
          actionKind: row.actionKind,
          direction: row.direction,
          passVersion: row.passVersion,
          presenceScope: row.presenceScope,
          at: row.at,
          undoes: row.undoes,
          override: row.override === 1,
        };
        return (await verifyScanRetentionProof(env, proof, scan))
          ? { id: row.id, passRef: row.passRef }
          : null;
      }),
    );
    for (const row of verified) if (row) out.set(row.id, { passRef: row.passRef });
  }
  return out;
}
