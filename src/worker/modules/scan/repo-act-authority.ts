import type { Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { EventRow } from '../events/repo.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { resolveReplayEvidence } from './repo-act-replay-proof.ts';
import { CURRENT_ISSUANCE, NO_PENDING_TRANSFER, RECORDED_PROOF } from './repo-act-replay-sql.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import { byIdStmt, type Candidate } from './repo-lookup.ts';
import { type Raw as RawScan, type ScanRow, toScan } from './repo-scan-map.ts';
import { scanPasslessCandidateSql } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql } from './repo-scan-retention.ts';
import type { ScanEventRow } from './repo-scope.ts';
import type { ScanEventReference } from './scan-event-proof.ts';
import type { PasslessScan } from './scan-passless.ts';
import type { ScanRetentionProofRow, ScanRetentionSnapshot } from './scan-retention-proof.ts';

/** The first action batch reads the actual row rather than a separate existence marker. */
export function replayScanByKeyStmt(
  db: D1Database,
  actorKey: string,
  key: string,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT * FROM scans WHERE actor_key=?/* scan-ephemeral-actor-key */
    AND idempotency_key=?/* scan-ephemeral-idempotency-key */`,
    [actorKey, key],
  );
}

export function replayScanFromResult(result: D1Result | undefined): ScanRow | null {
  const rows = result?.results as RawScan[] | undefined;
  if (rows?.length !== 1) return null;
  const row = rows[0];
  if (row === undefined) throw new Error('Invalid replay scan row');
  return toScan(row);
}

type RawEvent = {
  id: string;
  org_id: string;
  mode: Mode;
  name: string;
  match_input: string | null;
  match_values: string | null;
  opens_at: number;
  closes_at: number;
  time_zone: string;
  capacity: number | null;
  reentry: number;
  note: string | null;
  updated_at: number;
  archived_at: number | null;
};
function eventFromResult(result: D1Result | undefined): ScanEventRow | null {
  const raw = result?.results?.[0] as RawEvent | undefined;
  return raw
    ? {
        id: raw.id,
        orgId: raw.org_id,
        mode: raw.mode,
        name: raw.name,
        matchInput: raw.match_input,
        matchValues: raw.match_values,
        opensAt: raw.opens_at,
        closesAt: raw.closes_at,
        timeZone: raw.time_zone,
        capacity: raw.capacity,
        reentry: raw.reentry === 1,
        note: raw.note,
        updatedAt: raw.updated_at,
        archivedAt: raw.archived_at,
      }
    : null;
}

export interface ReplayEvidence {
  event: ScanEventRow | null;
  candidate: Candidate | null;
  target: ScanRow | null;
  ledger: EventRow | null;
  reference: ScanEventReference | null;
  recorded: Record<string, unknown> | null;
  approved: boolean;
  passless: PasslessScan | null;
  retention: { proof: ScanRetentionProofRow; scan: ScanRetentionSnapshot } | null;
}

/** Bounded original evidence, scope and candidate are captured in one D1 transaction. */
export async function readReplayEvidence(
  ctx: ServiceContext,
  actor: ScanActor,
  row: ScanRow,
  credentials: CredentialTombstoneSnapshot,
): Promise<ReplayEvidence> {
  const db = ctx.env.DB;
  if (
    row.outcome === null ||
    row.orgId !== actor.orgId ||
    row.mode !== actor.mode ||
    row.actorKey !== actor.actorKey ||
    row.scannerId !== (actor.scanner?.id ?? null) ||
    actor.role === null ||
    (actor.principal === 'admin' && actor.tenantAuthority?.capability !== 'passes:operate')
  )
    throw new StaleScanAuthority();
  const statements: D1PreparedStatement[] = [];
  const add = (statement: D1PreparedStatement) => {
    const index = statements.length;
    statements.push(statement);
    return index;
  };
  const eventIndex =
    row.eventId && actor.event?.id !== row.eventId
      ? add(
          stmt(
            db,
            `SELECT id,org_id,mode,name,match_input,match_values,opens_at,closes_at,time_zone,
        capacity,reentry,note,updated_at,archived_at FROM scan_events
        WHERE id=?/* scan-ephemeral-event-id */ AND org_id=?`,
            [row.eventId, actor.orgId],
          ),
        )
      : -1;
  const targetIndex = row.overrideOf
    ? add(
        stmt(
          db,
          `SELECT * FROM scans WHERE org_id=?
    AND id=?/* scan-ephemeral-scan-id */`,
          [actor.orgId, row.overrideOf],
        ),
      )
    : -1;
  let proofIndex = -1;
  let candidateIndex = -1;
  if (row.passId) {
    if (!row.templateId) throw new StaleScanAuthority();
    proofIndex = add(
      stmt(
        db,
        `SELECT l.id,l.org_id,l.pass_id,l.mode,l.kind,l.device,l.actor_type,l.actor_id,l.data,l.at,
      CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.pinnedTemplateVersion') END AS pinned_template_version,
      CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.walletVersion') END AS wallet_version,
      CASE WHEN json_valid(l.data) THEN json_extract(l.data,'$.authority.walletTemplateVersion') END AS wallet_template_version,
      CASE WHEN json_valid(l.data) THEN CASE WHEN (${RECORDED_PROOF}) THEN 1 ELSE 0 END ELSE 0 END AS approved_proof
      FROM scans q JOIN passes p ON p.id=q.pass_id AND p.org_id=q.org_id AND p.mode=q.mode AND p.test_data_quarantined=0
      JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}
      WHERE q.id=?/* scan-ephemeral-scan-id */ AND q.org_id=? AND q.mode=?
        AND (${NO_PENDING_TRANSFER}) AND (p.release_id IS NULL OR (${CURRENT_ISSUANCE}))`,
        [row.id, actor.orgId, actor.mode],
      ),
    );
    candidateIndex = add(byIdStmt(db, actor.orgId, row.passId));
  } else if (row.templateId === null) {
    proofIndex = add(
      stmt(
        db,
        `SELECT s.id AS scanId,s.org_id AS orgId,s.mode,s.at FROM scans s
      WHERE s.id=?/* scan-ephemeral-scan-id */ AND s.org_id=? AND s.mode=?
        AND ${scanPasslessCandidateSql('s')}`,
        [row.id, actor.orgId, actor.mode],
      ),
    );
  } else {
    proofIndex = add(
      stmt(
        db,
        `SELECT r.scan_id AS proofScanId,r.org_id AS proofOrgId,r.mode AS proofMode,
      r.ledger_event_id AS ledgerEventId,r.pass_ref AS passRef,r.event_digest AS eventDigest,r.scan_digest AS scanDigest,
      r.gate_snapshot AS gateSnapshot,r.presence_snapshot AS presenceSnapshot,r.mac,r.excluded,r.invalidated,
      s.id,s.org_id AS orgId,s.mode,s.template_id AS templateId,s.scanner_id AS scannerId,s.event_id AS eventId,
      s.actor_type AS actorType,s.actor_id AS actorId,s.actor_key AS actorKey,s.staff_id AS staffId,
      s.approved_by AS approvedBy,s.method,s.state,s.outcome,s.reason,s.action_id AS actionId,
      s.action_kind AS actionKind,s.direction,s.pass_version AS passVersion,s.presence_scope AS presenceScope,
      s.at,s.undoes,(s.override_of IS NOT NULL) AS override FROM scans s
      JOIN scan_retention_proofs r ON r.scan_id=s.id WHERE s.id=?/* scan-ephemeral-scan-id */
        AND s.org_id=? AND s.mode=? AND ${scanRetentionCandidateSql('s')}`,
        [row.id, actor.orgId, actor.mode],
      ),
    );
  }
  const results = await db.batch(statements);
  const event = row.eventId
    ? actor.event?.id === row.eventId
      ? actor.event
      : eventFromResult(results[eventIndex])
    : null;
  if (row.eventId && !event) throw new StaleScanAuthority();
  const targetRaw =
    targetIndex < 0 ? undefined : (results[targetIndex]?.results?.[0] as RawScan | undefined);
  const target = targetRaw ? toScan(targetRaw) : null;
  const base: ReplayEvidence = {
    event,
    target,
    candidate: null,
    ledger: null,
    reference: null,
    recorded: null,
    approved: false,
    passless: null,
    retention: null,
  };
  return resolveReplayEvidence(ctx, row, credentials, results, proofIndex, candidateIndex, base);
}
