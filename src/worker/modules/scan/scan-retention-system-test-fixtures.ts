import { first, stmt } from '../../platform/db.ts';
import {
  clearScanRetentionDeleteStmt,
  readVerifiedScanRetentionProofs,
  stageScanRetentionDeleteStmt,
} from './repo-scan-retention.ts';
import { prepareScanRetentionDelete, verifyScanRetentionProof } from './scan-retention-proof.ts';
import { retainedOutCause } from './scan-retention-proof-data.ts';

type Row = Record<string, unknown>;

/** The stored proof and the stored scan as a verifier sees them; `proof` and `scan` override fields to tamper. */
export async function verifyStored(
  db: D1Database,
  env: object,
  scanId: string,
  tamper: { proof?: Row; scan?: Row } = {},
): Promise<boolean> {
  const r = await first<Row>(
    db,
    `SELECT r.scan_id,r.org_id AS proof_org,r.mode AS proof_mode,r.ledger_event_id,r.pass_ref,r.event_digest,
      r.scan_digest,r.gate_snapshot,r.presence_snapshot,r.mac,r.excluded,r.invalidated,
      s.id,s.org_id,s.mode,s.template_id,s.scanner_id,s.event_id,s.actor_type,s.actor_id,s.actor_key,
      s.staff_id,s.approved_by,s.method,s.state,s.outcome,s.reason,s.action_id,s.action_kind,s.direction,
      s.pass_version,s.presence_scope,s.at,s.undoes,(s.override_of IS NOT NULL) AS override,s.out_cause
     FROM scans s JOIN scan_retention_proofs r ON r.scan_id=s.id WHERE s.id=?`,
    [scanId],
  );
  if (!r) return false;
  const proof = {
    scanId: r.scan_id,
    orgId: r.proof_org,
    mode: r.proof_mode,
    ledgerEventId: r.ledger_event_id,
    passRef: r.pass_ref,
    eventDigest: r.event_digest,
    scanDigest: r.scan_digest,
    gateSnapshot: r.gate_snapshot,
    presenceSnapshot: r.presence_snapshot,
    mac: r.mac,
    excluded: r.excluded,
    invalidated: r.invalidated,
    ...tamper.proof,
  };
  const scan = {
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    templateId: r.template_id,
    scannerId: r.scanner_id,
    eventId: r.event_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorKey: r.actor_key,
    staffId: r.staff_id,
    approvedBy: r.approved_by,
    method: r.method,
    state: r.state,
    outcome: r.outcome,
    reason: r.reason,
    actionId: r.action_id,
    actionKind: r.action_kind,
    direction: r.direction,
    passVersion: r.pass_version,
    presenceScope: r.presence_scope,
    at: r.at,
    undoes: r.undoes,
    override: r.override === 1,
    outCause: retainedOutCause(String(r.actor_type), (r.out_cause as string | null) ?? null),
    ...tamper.scan,
  };
  return verifyScanRetentionProof(env, proof, scan);
}

/** Hard-delete a pass the way the retention flow does, so its scans survive passless with their proofs. */
export async function deletePass(
  db: D1Database,
  env: object,
  pass: { id: string; orgId: string; mode: 'live' | 'test' },
): Promise<void> {
  const prepared = await prepareScanRetentionDelete(env, pass);
  await db.batch([
    stageScanRetentionDeleteStmt(db, pass.id, prepared),
    stmt(db, 'DELETE FROM passes WHERE id=? RETURNING id', [pass.id]),
    clearScanRetentionDeleteStmt(db, prepared),
  ]);
}

/** Whether the passless scan is a verified retention candidate. */
export async function retained(
  db: D1Database,
  env: object,
  scope: { orgId: string; mode: 'live' | 'test' },
  scanId: string,
): Promise<boolean> {
  return (await readVerifiedScanRetentionProofs(db, env, scope, [scanId])).has(scanId);
}

export const proofCount = async (db: D1Database, scanId: string): Promise<number> =>
  (
    await first<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM scan_retention_proofs WHERE scan_id=?',
      [scanId],
    )
  )?.n ?? 0;
