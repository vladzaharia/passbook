import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { StaleScanAuthority } from './act-override.ts';
import { type ActorCsrfSnapshot, actorCsrfSnapshotFence } from './actor-csrf.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import type { ReplayEvidence } from './repo-act-authority.ts';
import { CURRENT_ISSUANCE, NO_PENDING_TRANSFER, RECORDED_PROOF } from './repo-act-replay-sql.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import { scanTemplateSnapshotPredicate } from './repo-live-template-snapshot.ts';
import type { Candidate } from './repo-lookup.ts';
import { outputAuthorityPredicate } from './repo-output-authority.ts';
import {
  andOutputPredicates,
  type OutputPredicate,
  outputPredicateStmt,
} from './repo-output-predicates.ts';
import type { ScanRow } from './repo-scan-map.ts';
import { scanPasslessSnapshotPredicate } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql } from './repo-scan-retention.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { minimalHistoryAuthorityPredicate } from './repo-session-authority.ts';

const SCAN_MATCH = `q.id=?/* scan-ephemeral-scan-id */ AND q.org_id=? AND q.mode=?
  AND q.actor_key=?/* scan-ephemeral-actor-key */ AND q.scanner_id IS ?/* scan-ephemeral-scanner-id */
  AND q.state='done' AND q.outcome IS ? AND q.reason IS ?/* scan-ephemeral-history-reason */
  AND q.pass_id IS ?/* scan-ephemeral-pass-id */ AND q.template_id IS ?/* scan-ephemeral-template-id */
  AND q.event_id IS ?/* scan-ephemeral-event-id */ AND q.staff_id IS ?/* scan-ephemeral-staff-id */
  AND q.action_id IS ?/* scan-ephemeral-action-id */ AND q.action_kind IS ?
  AND q.override_of IS ?/* scan-ephemeral-history-override-of */ AND q.approved_by IS ?/* scan-ephemeral-approver-id */
  AND q.pass_version IS ? AND q.method=? AND q.at=?
  AND q.idempotency_key=?/* scan-ephemeral-idempotency-key */ AND q.request_hash=?/* scan-ephemeral-request-hash */
  AND q.direction IS ? AND q.presence_scope IS ?/* scan-ephemeral-event-scope */`;

function scanParams(row: ScanRow, req: ActRequest): SqlValue[] {
  return [
    row.id,
    row.orgId,
    row.mode,
    row.actorKey,
    row.scannerId,
    row.outcome,
    row.reason,
    row.passId,
    row.templateId,
    row.eventId,
    row.staffId,
    row.actionId,
    row.actionKind,
    row.overrideOf,
    row.approvedBy,
    row.passVersion,
    row.method,
    row.at,
    req.idempotencyKey,
    row.requestHash,
    row.direction ?? null,
    row.presenceScope ?? null,
  ];
}

/** One final read transaction binds the receipt and, independently, any richer projection. */
export async function replayCurrent(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
  row: ScanRow,
  credentials: CredentialTombstoneSnapshot,
  csrfSnapshot: ActorCsrfSnapshot,
  evidence: ReplayEvidence,
  projected: Candidate | null,
  projectedEvent: ScanEventRow | null,
): Promise<boolean> {
  const csrf = actorCsrfSnapshotFence(actor, csrfSnapshot);
  if (!csrf) throw new StaleScanAuthority();
  const tombstones = noCredentialTombstonesSql(
    credentials.credentialTombstoneRefs,
    { orgIdSql: 'q.org_id', modeSql: 'q.mode' },
    credentials.credentialKeysetCommitment,
  );
  const matchParams = scanParams(row, req);
  // Each staged check rebinds the complete receipt so it cannot refer to another scan.
  const receiptPart = (part: OutputPredicate, joins = ''): OutputPredicate => ({
    sql: `EXISTS (SELECT 1 FROM scans q ${joins}
    WHERE (${SCAN_MATCH}) AND (${part.sql}))`,
    params: [...matchParams, ...part.params],
  });
  const receiptParts: OutputPredicate[] = [receiptPart(tombstones)];
  if (evidence.ledger) {
    const l = evidence.ledger;
    const joins = `JOIN passes p ON p.id=q.pass_id AND p.org_id=q.org_id AND p.mode=q.mode AND p.test_data_quarantined=0
      JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}`;
    receiptParts.push(
      receiptPart({ sql: NO_PENDING_TRANSFER, params: [] }, joins),
      receiptPart({ sql: `(p.release_id IS NULL OR (${CURRENT_ISSUANCE}))`, params: [] }, joins),
      receiptPart(
        {
          sql: `l.id=?/* scan-ephemeral-history-ledger-id */ AND l.org_id=? AND l.pass_id=?/* scan-ephemeral-pass-id */
       AND l.mode=? AND l.kind=? AND l.device IS ?/* scan-ephemeral-event-device */
       AND l.actor_type IS ? AND l.actor_id IS ?/* scan-ephemeral-event-actor */
       AND l.data=?/* scan-ephemeral-source-event-json */ AND l.at=?`,
          params: [
            l.id,
            l.org_id,
            l.pass_id,
            l.mode,
            l.kind,
            l.device,
            l.actor_type,
            l.actor_id,
            l.data,
            l.at,
          ],
        },
        joins,
      ),
    );
    if (evidence.approved) {
      // Keep the deep recorded proof out of the enclosing staged WHERE expression.
      receiptParts.push({
        sql: `EXISTS (
          WITH recorded_receipt_proof AS MATERIALIZED (
            SELECT CASE WHEN json_valid(l.data) THEN (${RECORDED_PROOF}) ELSE 0 END AS approved
            FROM scans q ${joins}
            WHERE (${SCAN_MATCH})
          )
          SELECT 1 FROM recorded_receipt_proof WHERE approved
        )`,
        params: matchParams,
      });
    }
  } else if (evidence.passless) {
    const proof = scanPasslessSnapshotPredicate('q', evidence.passless);
    const other = noCredentialTombstonesSql(
      credentials.otherModeCredentialTombstoneRefs,
      { orgIdSql: 'q.org_id', modeSql: '?' },
      credentials.credentialKeysetCommitment,
    );
    receiptParts.push(
      receiptPart(proof),
      receiptPart({
        sql: other.sql,
        params:
          credentials.otherModeCredentialTombstoneRefs.length && other.sql !== '0'
            ? [actor.mode === 'live' ? 'test' : 'live', ...other.params]
            : other.params,
      }),
    );
  } else if (evidence.retention) {
    const { proof, scan } = evidence.retention;
    receiptParts.push(
      receiptPart({ sql: scanRetentionCandidateSql('q'), params: [] }),
      receiptPart({
        sql: `q.actor_type=? AND q.actor_id=?/* scan-ephemeral-actor-id */
      AND q.undoes IS ?/* scan-ephemeral-scan-id */ AND (q.override_of IS NOT NULL)=?
      AND EXISTS (SELECT 1 FROM scan_retention_proofs r WHERE r.scan_id=q.id AND r.org_id=? AND r.mode=?
        AND r.ledger_event_id=?/* scan-ephemeral-history-ledger-id */ AND r.pass_ref=?/* scan-ephemeral-proof */
        AND r.event_digest=?/* scan-ephemeral-proof */ AND r.scan_digest=?/* scan-ephemeral-proof */
        AND r.gate_snapshot IS ?/* scan-ephemeral-gate-snapshot */
        AND r.presence_snapshot IS ?/* scan-ephemeral-presence-snapshot */ AND r.mac=?/* scan-ephemeral-proof */
        AND r.excluded=0 AND r.invalidated=0)`,
        params: [
          scan.actorType,
          scan.actorId,
          scan.undoes,
          scan.override ? 1 : 0,
          proof.orgId,
          proof.mode,
          proof.ledgerEventId,
          proof.passRef,
          proof.eventDigest,
          proof.scanDigest,
          proof.gateSnapshot,
          proof.presenceSnapshot,
          proof.mac,
        ],
      }),
    );
  } else throw new StaleScanAuthority();
  const receipt = andOutputPredicates(receiptParts);
  const scope = minimalHistoryAuthorityPredicate(actor, ctx.clock.now(), {
    scanAlias: 'q',
    ...(evidence.ledger ? { ledgerAlias: 'l' } : {}),
    events: evidence.event ? [evidence.event] : [],
  });
  const scopeJoin = evidence.ledger
    ? `JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}`
    : '';
  const actorFence: OutputPredicate = {
    sql: `EXISTS (SELECT 1 FROM scans q ${scopeJoin}
    WHERE q.id=?/* scan-ephemeral-scan-id */ AND (${scope.sql}) AND (${csrf.sql}))`,
    params: [row.id, ...scope.params, ...csrf.params],
  };
  const statements = [
    outputPredicateStmt(ctx.env.DB, receipt),
    outputPredicateStmt(ctx.env.DB, actorFence),
  ];
  if (projected) {
    const output = outputAuthorityPredicate({
      actor,
      event: projectedEvent,
      now: ctx.clock.now(),
      adminEventTemplates: actor.principal === 'admin' && !req.scope?.templateIds?.length,
      templateId: row.templateId ?? undefined,
      pass: projected.pass,
      connectionGeneration: projected.connectionGeneration,
      activeTemplateVersion: projected.activeTemplateVersion,
      orgRevision: projected.orgRevision,
      templateRevision: projected.templateRevision,
      credentialTombstoneRefs: credentials.credentialTombstoneRefs,
      credentialKeysetCommitment: credentials.credentialKeysetCommitment,
      release: projected,
      purpose: 'commit',
      requireActive: true,
      displayTemplateVersion: projected.displayTemplateVersion,
      checkInRules: projected.checkInRules ?? {},
      lookupHash: projected.lookupHash,
    });
    const template = scanTemplateSnapshotPredicate(projected, projected.templateSnapshot, 'commit');
    const target = evidence.target;
    const projectionParts: OutputPredicate[] = [
      {
        sql: `EXISTS (SELECT 1 FROM (SELECT ? AS org_id,? AS mode) scope WHERE (${template.sql}))`,
        params: [actor.orgId, actor.mode, ...template.params],
      },
    ];
    if (row.overrideOf && target) {
      projectionParts.push({
        sql: `EXISTS (SELECT 1 FROM scans target
      WHERE target.id=?/* scan-ephemeral-scan-id */ AND target.org_id=? AND target.mode=?
        AND target.actor_key=?/* scan-ephemeral-actor-key */ AND target.pass_id IS ?/* scan-ephemeral-pass-id */
        AND target.action_id IS ?/* scan-ephemeral-action-id */ AND target.reason IS ?/* scan-ephemeral-history-reason */)`,
        params: [
          target.id,
          target.orgId,
          target.mode,
          target.actorKey,
          target.passId,
          target.actionId,
          target.reason,
        ],
      });
    }
    statements.push(
      outputPredicateStmt(ctx.env.DB, output),
      outputPredicateStmt(ctx.env.DB, andOutputPredicates(projectionParts)),
    );
  }
  const results = await ctx.env.DB.batch(statements);
  const authorized = (index: number) => {
    const value = results[index]?.results?.[0];
    return !!value && typeof value === 'object' && 'authorized' in value && value.authorized === 1;
  };
  if (!authorized(0) || !authorized(1)) throw new StaleScanAuthority();
  return projected !== null && authorized(2) && authorized(3);
}
