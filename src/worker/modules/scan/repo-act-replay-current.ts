import { PRESENT } from '../../platform/authority-read.ts';
import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { CredentialTombstoneSnapshot } from './credential-input.ts';
import type { ScanActor } from './guard.ts';
import { RACE_PREDICATE_AUTHORIZED } from './race-tags.ts';
import type { ReplayEvidence } from './repo-act-authority.ts';
import { CURRENT_ISSUANCE, NO_PENDING_TRANSFER, RECORDED_PROOF } from './repo-act-replay-sql.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { uniqueScanEventIdSql } from './repo-history-provenance.ts';
import type { Candidate } from './repo-lookup.ts';
import { type ScanReadAuthority, scanRead, scanReadAuthority } from './repo-read-authority.ts';
import { type Fence, passAnswerFence } from './repo-read-fences.ts';
import { ownScansWhere } from './repo-scan-history.ts';
import type { ScanRow } from './repo-scan-map.ts';
import { scanPasslessSnapshotPredicate } from './repo-scan-passless.ts';
import { scanRetentionCandidateSql } from './repo-scan-retention.ts';
import type { ScanEventRow } from './repo-scope.ts';
import { scanConjunction } from './scan-conjunction.ts';
import { predicateStmt, type ScanPredicate } from './scan-predicate.ts';

const SCAN_MATCH = scanConjunction([
  'q.id=? AND q.org_id=? AND q.mode=?',
  'q.actor_key=? AND q.scanner_id IS ?',
  "q.state='done' AND q.outcome IS ? AND q.reason IS ?",
  'q.pass_id IS ? AND q.template_id IS ?',
  'q.event_id IS ? AND q.staff_id IS ?',
  'q.action_id IS ? AND q.action_kind IS ?',
  'q.override_of IS ? AND q.approved_by IS ?',
  'q.pass_version IS ? AND q.method=? AND q.at=?',
  'q.idempotency_key=? AND q.request_hash=?',
  'q.direction IS ? AND q.presence_scope IS ?',
]);

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
  evidence: ReplayEvidence,
  projected: Candidate | null,
  projectedEvent: ScanEventRow | null,
): Promise<boolean> {
  const tombstones = noCredentialTombstonesSql(
    credentials.credentialTombstoneRefs,
    { orgIdSql: 'q.org_id', modeSql: 'q.mode' },
    credentials.credentialKeysetCommitment,
  );
  const matchParams = scanParams(row, req);
  // Each staged check rebinds the complete receipt so it cannot refer to another scan.
  const receiptPart = (part: ScanPredicate, joins = ''): ScanPredicate => ({
    sql: `EXISTS (SELECT 1 FROM scans q ${joins}
    WHERE (${SCAN_MATCH}) AND (${part.sql}))`,
    params: [...matchParams, ...part.params],
  });
  const receiptParts: ScanPredicate[] = [receiptPart(tombstones)];
  if (evidence.ledger) {
    const l = evidence.ledger;
    const joins = `JOIN passes p ON p.id=q.pass_id AND p.org_id=q.org_id AND p.mode=q.mode AND p.test_data_quarantined=0
      JOIN pass_events l ON l.id=${uniqueScanEventIdSql('q')}`;
    receiptParts.push(
      receiptPart({ sql: NO_PENDING_TRANSFER, params: [] }, joins),
      receiptPart({ sql: `(p.release_id IS NULL OR (${CURRENT_ISSUANCE}))`, params: [] }, joins),
      receiptPart(
        {
          sql: `l.id=? AND l.org_id=? AND l.pass_id=?
       AND l.mode=? AND l.kind=? AND l.device IS ?
       AND l.actor_type IS ? AND l.actor_id IS ?
       AND l.data=? AND l.at=?`,
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
        sql: `q.actor_type=? AND q.actor_id=?
      AND q.undoes IS ? AND (q.override_of IS NOT NULL)=?
      AND EXISTS (SELECT 1 FROM scan_retention_proofs r WHERE r.scan_id=q.id AND r.org_id=? AND r.mode=?
        AND r.ledger_event_id=? AND r.pass_ref=?
        AND r.event_digest=? AND r.scan_digest=?
        AND r.gate_snapshot IS ?
        AND r.presence_snapshot IS ? AND r.mac=?
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
  // The receipt is the actor's own recorded scan, inside the scope its assignment grants now.
  const now = ctx.clock.now();
  const auth = scanReadAuthority(actor, {
    now,
    ...(evidence.event ? { event: evidence.event } : {}),
  });
  const own = ownScansWhere(actor);
  // One statement per receipt part: each rebinds the whole receipt, so none can name another scan.
  const statements = [
    ...receiptParts.map((part) => predicateStmt(ctx.env.DB, part)),
    ownedReceiptStmt(ctx.env.DB, auth, own, row.id),
  ];
  const receiptCount = statements.length;
  let projection = 0;
  if (projected) {
    const inner = passAnswerFence(actor, projected, {
      photo: false,
      refs: credentials.credentialTombstoneRefs,
    });
    const target = evidence.target;
    // The pass the answer reads, under the actor's authority and at the release it was read under.
    const auth = scanReadAuthority(actor, {
      now,
      event: projectedEvent,
      ...(row.templateId ? { templateId: row.templateId } : {}),
    });
    statements.push(
      inner
        ? projectionStmt(ctx.env.DB, auth, inner)
        : predicateStmt(ctx.env.DB, { sql: '0', params: [] }),
    );
    projection = 1;
    if (row.overrideOf && target) {
      statements.push(
        predicateStmt(ctx.env.DB, {
          sql: `EXISTS (SELECT 1 FROM scans target
      WHERE target.id=? AND target.org_id=? AND target.mode=?
        AND target.actor_key=? AND target.pass_id IS ?
        AND target.action_id IS ? AND target.reason IS ?)`,
          params: [
            target.id,
            target.orgId,
            target.mode,
            target.actorKey,
            target.passId,
            target.actionId,
            target.reason,
          ],
        }),
      );
      projection = 2;
    }
  }
  const results = await ctx.env.DB.batch(statements);
  const authorized = (index: number) => {
    const value = results[index]?.results?.[0];
    return !!value && typeof value === 'object' && 'authorized' in value && value.authorized === 1;
  };
  for (let index = 0; index < receiptCount; index++)
    if (!authorized(index)) throw new StaleScanAuthority();
  if (projected === null) return false;
  for (let index = 0; index < projection; index++)
    if (!authorized(receiptCount + index)) return false;
  return true;
}

/** One row while the receipt scan is the actor's own, inside its scope, and its authority holds. */
export const ownedReceiptStmt = (
  db: D1Database,
  auth: ScanReadAuthority,
  own: { sql: string; params: SqlValue[] },
  scanId: string,
) =>
  scanRead(
    db,
    auth,
    `${RACE_PREDICATE_AUTHORIZED} SELECT 1 AS authorized FROM ${auth.rows}scans s
      WHERE ${auth.present} AND s.id = ? AND ${auth.tenantOnce('s', 'scans')} AND ${own.sql}`,
    [scanId, ...own.params],
  );

/** One row while the actor's authority holds and the pass answer's fence does. */
export const projectionStmt = (db: D1Database, auth: ScanReadAuthority, inner: Fence) =>
  scanRead(
    db,
    auth,
    `${RACE_PREDICATE_AUTHORIZED} SELECT 1 AS authorized FROM actor_ok ao WHERE ${PRESENT} = 1 AND ${inner.sql}`,
    inner.params,
  );
