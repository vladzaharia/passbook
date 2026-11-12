import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { not } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialFacts, lostReason } from './act-check-in-facts.ts';
import { finishCheckInResult } from './act-check-in-result.ts';
import type { ActRequest } from './act-claim.ts';
import { heldOutcome } from './act-held.ts';
import type { HeldHolder } from './act-held-holder.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { ActionHistoryPreflight } from './act-preflight.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ScanActor } from './actor.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { historyPlan } from './card.ts';
import { planCommitCounts } from './counts.ts';
import { preparePlannedDisplayHistoryProof } from './history-proof-pending.ts';
import { appendPlannedDisplayHistory, rebindDisplayHistoryRead } from './history-proof-plan.ts';
import { type LedgerFacts, ledgerRow } from './ledger.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { prepareAssetGrantInsertion } from './repo-asset-grants.ts';
import * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { doneOkPredicate, holderPart } from './repo-scan-checks.ts';
import * as snapshots from './repo-scan-effect.ts';
import { retentionProofIfRecordedStmt } from './repo-scan-retention.ts';
import type { Found } from './resolve.ts';
import { capturingDb } from './scan-capture.ts';
import {
  type DisplayHistoryPlan,
  displayNeedsFor,
  displayRequiresHistory,
  prepareDisplayHistory,
} from './scan-display-history.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import {
  capacityOpen,
  retentionPart,
  SCAN_COMMIT_TABLES,
  scanIs,
  scanWriteGrant,
  wonGate,
} from './scan-write-grant.ts';
import {
  type Finalize,
  finalizeScan,
  ledgerEvent,
  writeGate,
  writePresence,
} from './scan-write-statements.ts';
import type { PinReservation } from './staff-pin.ts';

interface CheckInSuccessInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  req: ActRequest;
  csrfSnapshot: ActorCsrfSnapshot;
  history: ActionHistoryPreflight | null;
  photo: PreparedPhotoGrant | null;
  reservation: PinReservation | null;
  action: ResolvedScanAction;
  undoWindow: number;
  gate: gates.GateKey;
  claim: gates.GateClaim;
  presencePlan: Found['admission'];
  stopAuthority: StopAuthority;
  originalCandidate: Candidate | null;
  facts: Omit<LedgerFacts, 'outcome' | 'reason'>;
  approver: { id: string; authEpoch: number } | null;
  onFailureCommitted(): void;
}

/**
 * Commit the preflighted gate effect in one grant batch. A scan that loses the gate (or finds the
 * event full) in the meantime commits a truthful heads-up in the same trip, so ten racing scanners
 * give one `ok` and nine `already_done`, and nothing is half written.
 */
export async function commitCheckInSuccess(input: CheckInSuccessInput): Promise<ScanOutcome> {
  const { ctx, actor, found, req, csrfSnapshot, history, photo, reservation, action } = input;
  const { undoWindow, gate, claim, presencePlan, stopAuthority, originalCandidate } = input;
  const { facts, approver, onFailureCommitted } = input;
  const { scanId, claimAt, effect } = claim;
  const { actor: authorityActor, approvedBy, event } = claim.authority;
  const side = { ...ctx, env: { ...ctx.env, DB: capturingDb(ctx.env.DB) } };
  const sideDb = side.env.DB;
  const now = ctx.clock.now();
  const authorityNow = now;

  const variant = async (outcome: 'ok' | 'heads_up', reason: ScanReason | null) => {
    const held = outcome === 'heads_up';
    const e = held
      ? { ...effect, gateAfter: effect.gateBefore, presenceAfter: effect.presenceBefore }
      : effect;
    const row = await ledgerAuthoritySnapshot(
      ctx,
      ledgerRow(ctx, actor, {
        ...facts,
        outcome,
        reason,
        ...(held ? { override: false, approvedBy: null } : {}),
      }),
      found.pass,
      stopAuthority,
      {
        claimAt,
        credentialKeysetCommitment: claim.credentialKeysetCommitment,
        direction: found.admission?.state.direction ?? null,
        presenceScope: held ? null : (presencePlan?.scope ?? null),
        found,
        action,
        gate: snapshots.effectGate(gate.scope, held ? effect.gateBefore : effect.gateAfter),
        effect: e,
        gateScope: gate.scope,
      },
    );
    const retention = await prepareScanRetentionProof(ctx.env, row, actor.actorKey, {
      actionId: action.id,
    });
    return { row, retention };
  };
  const lost = lostReason(claim.gate);
  const capacity = claim.capacity
    ? capacityOpen(
        gates.capacityFullPredicate(
          claim.orgId,
          claim.mode,
          claim.capacity.eventId,
          claim.capacity.max,
          claim.capacity.reentry,
          claim.passId,
        ),
      )
    : null;
  const [ok, lostVariant, capVariant] = await Promise.all([
    variant('ok', null),
    variant('heads_up', lost),
    capacity ? variant('heads_up', 'capacity_full') : Promise.resolve(null),
  ]);

  const finalized = (outcome: 'ok' | 'heads_up', reason: ScanReason | null): Finalize => ({
    id: scanId,
    claimAt,
    outcome,
    reason,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    actionId: action.id,
    actionKind: action.kind,
    passVersion: found.pass.version,
    overrideOf: outcome === 'ok' ? (req.overrideOf ?? null) : null,
    approvedBy: outcome === 'ok' ? approvedBy : null,
    direction: found.admission?.state.direction,
    ...(outcome === 'ok' && presencePlan ? { presenceScope: presencePlan.scope } : {}),
    ...(event ? { eventId: event.id } : {}),
  });

  // Planned before the grant exists: they only need values, never the grant row.
  let displayPlan: DisplayHistoryPlan;
  if (displayRequiresHistory(found)) {
    if (!history || !rebindDisplayHistoryRead(history.preloaded, actor, found))
      throw new StaleScanAuthority();
    const planned = await preparePlannedDisplayHistoryProof(
      history.source,
      actor,
      found,
      ok.retention,
      finalized('ok', null),
    );
    if (!planned || !appendPlannedDisplayHistory(history.preloaded, planned))
      throw new StaleScanAuthority();
    displayPlan = await prepareDisplayHistory(
      ctx,
      actor,
      found,
      displayNeedsFor(found),
      history.preloaded,
    );
  } else displayPlan = await historyPlan(ctx, actor, found);
  if (photo && !originalCandidate) throw new StaleScanAuthority();
  const photoPlan =
    photo && originalCandidate
      ? await prepareAssetGrantInsertion(
          ctx,
          photo.grant,
          { recipientSnapshot: csrfSnapshot },
          originalCandidate,
          { soft: true },
        )
      : null;

  const g = scanWriteGrant(ctx, authorityActor, {
    purpose: 'org_mode.scan.check_in',
    now: authorityNow,
    event: event ?? null,
    pass: {
      id: found.pass.id,
      facts: {
        pass: found.pass,
        credential: 'code' in req.input ? credentialFacts(found.pass) : {},
      },
    },
    approver,
    // Another pass's transfer can retire the presented credential after resolve (shared hash).
    credentialRefs: { current: claim.credentialTombstoneRefs, other: [] },
    tables: SCAN_COMMIT_TABLES,
  });
  const won = wonGate(gate, scanId);
  const gateAfter = effect.gateAfter;
  if (!gateAfter) throw new StaleScanAuthority();
  writeGate(
    g,
    {
      passId: gate.passId,
      actionId: gate.actionId,
      scope: gate.scope,
      templateId: claim.templateId,
      kind: claim.kind,
      scanId,
      rule: claim.gate,
      at: authorityNow,
      before: effect.gateBefore,
      after: gateAfter,
    },
    capacity ? [capacity] : [],
  );
  if (presencePlan && effect.presenceAfter)
    writePresence(g, gate, scanId, effect.presenceBefore, effect.presenceAfter);
  const finalOk = finalizeScan(g, finalized('ok', null), [won]);
  const finalCap =
    capVariant && capacity
      ? finalizeScan(g, finalized('heads_up', 'capacity_full'), [not(capacity)])
      : null;
  finalizeScan(g, finalized('heads_up', lost));
  for (const [v, outcome, reason] of [
    [ok, 'ok', null],
    [capVariant, 'heads_up', 'capacity_full'],
    [lostVariant, 'heads_up', lost],
  ] as const) {
    if (!v) continue;
    ledgerEvent(g, v.row, scanId, outcome, reason);
    g.include(retentionPart(retentionProofIfRecordedStmt(sideDb, v.retention)));
  }
  const [holder] = g.include(holderPart(gate));
  g.assert('stale', [scanIs(scanId, { state: 'done' })]);

  // One transaction: the grant, then the reads and decoration that must see its writes.
  const counts = planCommitCounts(ctx, actor, req.dayStart);
  const finishAt = ctx.clock.now();
  const done = doneOkPredicate(scanId);
  const bound = displayPlan.bind(finishAt, done);
  const photoInsert = photoPlan ? photoPlan(finishAt, done, { sql: '1', params: [] }) : [];
  const refund = reservation?.refundStatements() ?? [];
  const committed = await g.commitWith([
    ...counts.stmts,
    ...bound.stmts,
    ...photoInsert,
    ...refund,
  ]);
  reservation?.markRefunded();
  const results = committed.writes;
  const at = (s: Parameters<typeof g.indexOf>[0]) => results[g.indexOf(s)] as D1Result;
  const rows = (s: Parameters<typeof g.indexOf>[0]) => (at(s).results ?? []).length;
  const wonIt = rows(finalOk) > 0;
  const reason: ScanReason = finalCap && rows(finalCap) ? 'capacity_full' : lost;
  if (!wonIt) onFailureCommitted();
  const read = await counts.read(committed.after);
  const rest = committed.after.slice(counts.stmts.length);
  if (!wonIt) {
    const holderRow = (at(holder as never).results?.[0] ?? undefined) as HeldHolder | undefined;
    return heldOutcome({
      ctx,
      actor,
      found,
      action,
      scanId,
      reason,
      holder: holderRow,
      read,
      display: null,
      now: finishAt,
    });
  }
  return finishCheckInResult({
    ctx,
    actor,
    authorityActor,
    found,
    action,
    scanId,
    now: authorityNow,
    undoWindow,
    read,
    display: {
      finalize: (r) => bound.finalize(r),
      results: rest.slice(0, bound.stmts.length),
    },
    photo,
    photoResults: rest.slice(bound.stmts.length, bound.stmts.length + photoInsert.length),
    hasPresence: !!presencePlan,
  });
}
