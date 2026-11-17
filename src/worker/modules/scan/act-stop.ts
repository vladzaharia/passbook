import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ActRequest } from './act-claim.ts';
import { CommittedScanUnconfirmed, StaleScanAuthority } from './act-override.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { historyPlan } from './card.ts';
import { type CountsPlan, planCommitCounts } from './counts.ts';
import type { ScanActor } from './guard.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import { ledgerRow, recordResult } from './ledger.ts';
import { type PreparedPhotoGrant, photoGrantUrl } from './member-photo.ts';
import { prepareMiss } from './misses.ts';
import { stopOutcome } from './outcome.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { candidateTemplateFenceStmt, templateFenceHolds } from './repo-resolve-outcome-current.ts';
import { doneScanPredicate } from './repo-scan-checks.ts';
import { retentionProofIfRecordedStmt } from './repo-scan-retention.ts';
import type { Claim } from './repo-scans.ts';
import type { Stop } from './resolve.ts';
import { afterReads, capturingDb } from './scan-capture.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import { retentionPart, SCAN_STOP_TABLES, scanIs, scanWriteGrant } from './scan-write-grant.ts';
import { finalizeScan, ledgerEvent } from './scan-write-statements.ts';

export interface StopContext {
  ctx: ServiceContext;
  actor: ScanActor;
  scanId: string;
  ownedClaim: Claim;
  claimAt: number;
  method: ActRequest['input']['method'];
  idempotencyKey: string;
  requestHash: string;
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  csrfSnapshot: ActorCsrfSnapshot;
  history?: PreloadedDisplayHistory;
  photo: PreparedPhotoGrant | null;
  countMiss?: boolean;
  suppressCounts?: boolean;
  dayStart?: number;
  action: ResolvedScanAction | null;
  overrideOf: string | null;
  onFailureCommitted(): void;
}

/**
 * Closes the claimed row with a refusal or heads-up that came before any gate. One grant batch holds
 * the finalize, the ledger event of a known pass and the retention proof. The miss counter, counts and card
 * follow in a second batch: they decorate the answer, so a failure there degrades it.
 */
export async function finishStop(
  s: StopContext,
  stop: Stop,
  authority: StopAuthority,
  auditPass: Pass | null = null,
): Promise<ScanOutcome> {
  const { ctx, actor } = s;
  const side = { ...ctx, env: { ...ctx.env, DB: capturingDb(ctx.env.DB) } };
  const pass = stop.pass ?? auditPass;
  const ledger = pass
    ? await ledgerAuthoritySnapshot(
        ctx,
        ledgerRow(ctx, actor, {
          pass,
          scanId: s.scanId,
          action: s.action,
          outcome: stop.kind,
          reason: stop.reason,
          method: s.method,
          override: s.overrideOf !== null,
          approvedBy: null,
        }),
        pass,
        authority,
        {
          claimAt: s.claimAt,
          credentialKeysetCommitment: s.credentialKeysetCommitment,
          direction: null,
          presenceScope: null,
          found: stop.found,
          action: s.action,
        },
      )
    : null;
  const retention = ledger
    ? await prepareScanRetentionProof(ctx.env, ledger, actor.actorKey, {
        actionId: s.action?.id ?? null,
      })
    : null;
  const photo = s.photo;
  const displayPlan = stop.found ? await historyPlan(ctx, actor, stop.found, s.history) : null;

  const now = ctx.clock.now();
  const checked = stop.found?.pass ?? stop.pass ?? stop.auditCandidate?.pass ?? null;
  const g = scanWriteGrant(ctx, authority.actor, {
    purpose: 'org_mode.scan.stop',
    now,
    event: authority.event ?? null,
    ...(authority.templateId ? { templateId: authority.templateId } : {}),
    // A pass or a miss: the scanner's mode may not have retired the presented credential.
    ...(checked || s.countMiss ? { credentialRefs: s.credentialTombstoneRefs } : {}),
    ...(checked ? { pass: { id: checked.id, facts: { pass: checked, credential: {} } } } : {}),
    tables: SCAN_STOP_TABLES,
  });
  const finalized = finalizeScan(g, {
    id: s.scanId,
    claimAt: s.claimAt,
    outcome: stop.kind,
    reason: stop.reason,
    passId: pass?.id ?? null,
    templateId: pass?.templateId ?? null,
    actionId: s.action?.id ?? null,
    actionKind: s.action?.kind ?? null,
    passVersion: pass?.version ?? null,
    overrideOf: s.overrideOf,
    approvedBy: null,
    ...(authority.event ? { eventId: authority.event.id } : {}),
  });
  if (ledger && retention) {
    ledgerEvent(g, ledger, s.scanId, stop.kind, stop.reason);
    g.include(retentionPart(retentionProofIfRecordedStmt(side.env.DB, retention)));
  }
  g.assert('stale', [scanIs(s.scanId, { state: 'done' })]);
  const dayCounts: CountsPlan | null = s.suppressCounts
    ? null
    : planCommitCounts(ctx, actor, s.dayStart);
  // The answer was read under a template snapshot: it is served only while that snapshot still stands.
  const fence = stop.found?.liveCandidate;
  const committed = await g.commitWith(
    afterReads([
      ...(fence ? [candidateTemplateFenceStmt(side.env.DB, fence)] : []),
      ...(dayCounts?.stmts ?? []),
    ]),
  );
  const results = committed.writes;
  if (!(results[g.indexOf(finalized)]?.results ?? []).length) {
    s.onFailureCommitted();
    throw new StaleScanAuthority();
  }

  if (fence && !templateFenceHolds(committed.after[0])) throw new CommittedScanUnconfirmed();
  // Recorded with its counts. The miss counter and card follow; a failure only degrades the answer.
  const finishAt = ctx.clock.now();
  const done = doneScanPredicate(s.scanId);
  const clock = { ...ctx, clock: { now: () => finishAt } };
  const miss = s.countMiss ? prepareMiss(clock, authority.actor, s.scanId, s.claimAt) : null;
  const bound = displayPlan?.bind(finishAt, done);
  const statements = [...(miss?.stmts ?? []), ...(bound?.stmts ?? [])];
  let after: D1Result[] | null = null;
  try {
    after = statements.length ? await ctx.env.DB.batch(statements) : [];
  } catch (error) {
    ctx.log.error('scan.finish_degraded', {
      code: 'SCAN_FINISH_DEGRADED',
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
  const missEnd = miss?.stmts.length ?? 0;
  const missResult = miss && after ? miss.result(after.slice(0, missEnd)) : null;
  const read = dayCounts
    ? await dayCounts.read(committed.after.slice(fence ? 1 : 0))
    : { approvals: false, counts: { today: 0, event: null, asOf: 0, configRev: 0 } };
  const boundStart = missEnd;
  const history =
    bound && after
      ? bound.finalize(after.slice(boundStart, boundStart + bound.stmts.length))
      : undefined;
  const photoUrl =
    photo && stop.found ? photoGrantUrl(authority.actor, stop.found.pass.id, photo.grant) : null;
  if (miss && missResult) miss.throwIfCapped(missResult);
  recordResult(ctx, actor, pass?.templateId ?? null, stop.reason, pass?.mode);
  const outcome = stopOutcome(ctx, actor, stop, read, {
    action: s.action,
    scanId: s.scanId,
    history: history ?? undefined,
    photoUrl,
  });
  // A passless refusal answers with its recorded row's time, as its replay does.
  return pass ? outcome : { ...outcome, at: s.claimAt };
}
