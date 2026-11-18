import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanAccessOf, startsVisit, waiveOf } from './access.ts';
import { commitConditions, credentialFacts, lostReason } from './act-check-in-facts.ts';
import { finishCheckInResult } from './act-check-in-result.ts';
import { addCheckInStatements } from './act-check-in-statements.ts';
import type { ActRequest } from './act-claim.ts';
import { heldOutcome } from './act-held.ts';
import type { HeldHolder } from './act-held-holder.ts';
import { StaleScanAuthority } from './act-override.ts';
import type { ActionHistoryPreflight } from './act-preflight.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ScanActor } from './actor.ts';
import { historyPlan } from './card.ts';
import { planCommitCounts } from './counts.ts';
import { preparePlannedDisplayHistoryProof } from './display-history-pending.ts';
import { appendPlannedDisplayHistory, rebindDisplayHistoryRead } from './display-history-plan.ts';
import { type LedgerFacts, ledgerRow } from './ledger.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import { ACCESS_GATE, accessCountStmt, accessInputPin, accessZoneChecks } from './repo-access.ts';
import * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import { doneOkPredicate, effectiveReleaseCheck } from './repo-scan-checks.ts';
import * as snapshots from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import { afterReads } from './scan-capture.ts';
import {
  type DisplayHistoryPlan,
  displayNeedsFor,
  displayRequiresHistory,
  prepareDisplayHistory,
} from './scan-display-history.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import type { StopAuthority } from './scan-stop-authority.ts';
import { capacityOpen, SCAN_COMMIT_TABLES, scanWriteGrant } from './scan-write-grant.ts';
import type { Finalize } from './scan-write-statements.ts';
import type { PinReservation } from './staff-pin.ts';

interface CheckInSuccessInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  req: ActRequest;
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
  const { ctx, actor, found, req, history, photo, reservation, action } = input;
  const { undoWindow, gate, claim, presencePlan, stopAuthority, originalCandidate } = input;
  const { facts, approver, onFailureCommitted } = input;
  const { scanId, claimAt, effect } = claim;
  const { actor: authorityActor, approvedBy, event } = claim.authority;
  const now = ctx.clock.now();
  const authorityNow = now;

  const access = found.access && gate.actionId === ACCESS_GATE ? found.access : null;
  // The visit gate is `access`; the ledger names the action that was scanned (its signed reference).
  const named = <T extends { actionId: string }>(g: T | null) =>
    g && access ? { ...g, actionId: action.id } : g;

  const variant = async (outcome: 'ok' | 'heads_up', reason: ScanReason | null) => {
    const held = outcome === 'heads_up';
    const moved = held
      ? { ...effect, gateAfter: effect.gateBefore, presenceAfter: effect.presenceBefore }
      : effect;
    const e = { ...moved, gateBefore: named(moved.gateBefore), gateAfter: named(moved.gateAfter) };
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
  // The admission or override that let this scan in, repeated in the gate write (another door wins).
  const overrideOf = req.overrideOf ?? null;
  const admitted = commitConditions(gate.passId, presencePlan, effect.presenceBefore, overrideOf);
  const [ok, lostVariant, capVariant, admitVariant] = await Promise.all([
    variant('ok', null),
    variant('heads_up', lost),
    capacity ? variant('heads_up', 'capacity_full') : Promise.resolve(null),
    admitted.conds.length && admitted.reason !== lost
      ? variant('heads_up', admitted.reason)
      : Promise.resolve(null),
  ]);

  const finalized = (
    outcome: 'ok' | 'heads_up',
    reason: ScanReason | null,
    visit?: boolean,
  ): Finalize => ({
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
    ...(access
      ? {
          access: {
            zoneId: access.zoneId,
            plan: access.decision.access.plan.id,
            visit: outcome === 'ok' ? (visit ?? false) : null,
          },
        }
      : {}),
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
    // A grant inside a visit is not a visit: the history will not count it.
    const counted = !access || startsVisit(access, now);
    if (!planned || (counted && !appendPlannedDisplayHistory(history.preloaded, planned)))
      throw new StaleScanAuthority();
    displayPlan = await prepareDisplayHistory(
      ctx,
      actor,
      found,
      displayNeedsFor(found),
      history.preloaded,
    );
  } else displayPlan = await historyPlan(ctx, actor, found);
  const g = scanWriteGrant(ctx, authorityActor, {
    purpose: 'org_mode.scan.check_in',
    now: authorityNow,
    event: event ?? null,
    pass: {
      id: found.pass.id,
      facts: {
        pass: found.pass,
        credential:
          'code' in req.input
            ? await credentialFacts(found.pass, originalCandidate, req.input.code)
            : {},
      },
    },
    approver,
    // The release the answer was evaluated under still stands (the pre-commit read cannot hold it).
    checks: [
      effectiveReleaseCheck(found.pass.id, found.liveCandidate?.templateSnapshot?.raw),
      // The zone that let the pass in is still live and still the session's (C6).
      ...(access
        ? [
            ...accessZoneChecks(access.chain, access.sessionId),
            accessInputPin(found.pass.id, found.pass.version),
          ]
        : []),
    ],
    // Another pass's transfer can retire the presented credential after resolve (shared hash).
    credentialRefs: claim.credentialTombstoneRefs,
    tables: SCAN_COMMIT_TABLES,
  });
  const statements = addCheckInStatements(g, {
    gate,
    claim,
    at: authorityNow,
    presencePlan,
    overrideOf,
    capacity,
    admitted,
    lost,
    finalized,
    access: access
      ? {
          templateId: found.pass.templateId,
          gapMs: access.gapMs,
          waitMs: access.waitMs,
          limit: access.limit,
          waiveWait: waiveOf(claim.authority.override?.reason).wait,
          waiveLimit: waiveOf(claim.authority.override?.reason).limit,
        }
      : null,
    variants: { ok, admit: admitVariant, cap: capVariant, lost: lostVariant },
  });
  if (!statements) throw new StaleScanAuthority();
  const { finalOk, finalVisit, finalAdmit, finalCap, holder, presenceHolder } = statements;

  // The verified PIN's attempt comes back with the scan, in the same commit.
  if (reservation) g.include(...reservation.refundParts());
  // One transaction: the grant, then the reads that must see its writes.
  const counts = planCommitCounts(ctx, actor, req.dayStart);
  const finishAt = ctx.clock.now();
  const done = doneOkPredicate(scanId);
  const bound = displayPlan.bind(finishAt, done);
  const committed = await g.commitWith(
    afterReads([
      ...counts.stmts,
      ...bound.stmts,
      ...(access ? [accessCountStmt(ctx.env.DB, found.pass.id)] : []),
    ]),
  );
  reservation?.markRefunded();
  const results = committed.writes;
  const at = (s: Parameters<typeof g.indexOf>[0]) => results[g.indexOf(s)] as D1Result;
  const rows = (s: Parameters<typeof g.indexOf>[0]) => (at(s).results ?? []).length;
  const startedVisit = !!finalVisit && rows(finalVisit) > 0;
  const wonIt = startedVisit || rows(finalOk) > 0;
  const admitLost = !!finalAdmit && rows(finalAdmit) > 0;
  const reason: ScanReason = admitLost
    ? admitted.reason
    : finalCap && rows(finalCap)
      ? 'capacity_full'
      : lost;
  if (!wonIt) onFailureCommitted();
  const read = await counts.read(committed.after);
  const rest = committed.after.slice(counts.stmts.length);
  if (!wonIt) {
    const holderOf = (s: unknown) => at(s as never).results?.[0] as HeldHolder | undefined;
    // Another scan admitted the pass first: name it, and offer no override (as a fresh read would).
    const held = heldOutcome({
      ctx,
      actor,
      found,
      action,
      scanId,
      reason,
      holder: (admitLost && presenceHolder && holderOf(presenceHolder)) || holderOf(holder),
      read,
      display: null,
      now: finishAt,
    });
    return admitLost ? { ...held, overridable: false } : held;
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
    hasPresence: !!presencePlan,
    access: access
      ? scanAccessOf(access.decision, {
          visits: {
            used: Number(
              (rest[bound.stmts.length]?.results?.[0] as { count?: number })?.count ?? 0,
            ),
            limit: access.limit,
          },
          visit: startedVisit,
        })
      : null,
  });
}
