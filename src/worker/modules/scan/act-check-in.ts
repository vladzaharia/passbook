import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startsVisit } from './access.ts';
import { occupancyEffect } from './act-check-in-occupancy.ts';
import { commitCheckInSuccess } from './act-check-in-success.ts';
import type { ActRequest } from './act-claim.ts';
import { gateWasHeld, type HeldGateSnapshot } from './act-gate-preflight.ts';
import { finishHeldGate } from './act-held.ts';
import { assertTapOut, type Override, StaleScanAuthority } from './act-override.ts';
import type { ActionHistoryPreflight, ActionPreflight } from './act-preflight.ts';
import { ScanAttemptRaced } from './act-stale-refusal.ts';
import { deferTermStart } from './act-term-stamp.ts';
import { commitValue } from './act-value.ts';
import { deepFreeze } from './freeze.ts';
import { gateRule, gateScope, settledAccessGate } from './gate.ts';
import type { ScanActor } from './guard.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import type * as gates from './repo-gates.ts';
import * as snapshots from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import type { PinReservation } from './staff-pin.ts';

interface CommitInput {
  ctx: ServiceContext;
  actor: ScanActor;
  authorityActor: ScanActor;
  req: ActRequest;
  scanId: string;
  claimAt: number;
  requestHash: string;
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  preflight: ActionPreflight;
  held: HeldGateSnapshot;
  history: ActionHistoryPreflight | null;
  photo: PreparedPhotoGrant | null;
  undoWindow: number;
  found: Found;
  action: ResolvedScanAction;
  override: Override | null;
  approvedBy: string | null;
  /** The verified approver's role: a Desk approver is pinned as such in the grant. */
  approvedRole?: 'door' | 'desk' | 'manager' | null;
  approvedAuthEpoch: number | null;
  reservation: PinReservation | null;
  onFailureCommitted(): void;
}
export async function commitCheckIn(input: CommitInput): Promise<ScanOutcome> {
  const {
    ctx,
    actor,
    authorityActor,
    found,
    req,
    preflight,
    held,
    history,
    photo,
    override,
    reservation,
    onFailureCommitted,
    ...source
  } = input;
  // What was read is not changed from here on: the grant batch decides, not a copy.
  deepFreeze(found);
  const originalCandidate = found.liveCandidate ?? null;
  const {
    scanId,
    claimAt,
    action,
    approvedBy,
    approvedAuthEpoch,
    requestHash,
    credentialTombstoneRefs,
    credentialKeysetCommitment,
    undoWindow,
  } = source;
  const _db = ctx.env.DB;
  const now = ctx.clock.now();
  const event = actor.event;
  if (
    !snapshots.credentialSnapshotMatches(
      req.input,
      credentialTombstoneRefs,
      found.credentialTombstoneRefs,
    ) ||
    found.credentialKeysetCommitment !== credentialKeysetCommitment
  )
    throw new StaleScanAuthority();
  // Step 15 and the effect: gate, finalize and ledger in one batch, counts behind them.
  const accessGate = settledAccessGate(found, action);
  // A tracked zone replaces admission: its in/out row decides, not the presence snapshot (SA §20.4).
  const place = found.occupancy ?? null;
  const rowGate: gates.GateKey = {
    passId: found.pass.id,
    actionId: action.id,
    // At a place, the action's gate is the one the preflight chose and read (an exit writes it).
    scope: place
      ? preflight.gate.scope
      : found.admission && (found.checkInRules?.mode || actor.settings.checkIn?.mode)
        ? found.admission.scope
        : gateScope(action, actor, now),
  };
  // The preflight read the action's own gate; an Access card's visit gate was read with its zones.
  const gate: gates.GateKey = accessGate ?? rowGate;
  if (!found.admission && event && (!found.eventAdmission || found.eventAdmissionReason))
    throw new StaleScanAuthority();
  const presencePlan = found.admission ?? found.eventAdmission;
  const presenceScope = place ? preflight.presenceScope : (presencePlan?.scope ?? rowGate.scope);
  // The preflight read no longer matches what was evaluated: another scan or edit moved the pass.
  if (
    preflight.gate.passId !== rowGate.passId ||
    preflight.gate.actionId !== rowGate.actionId ||
    preflight.gate.scope !== rowGate.scope ||
    preflight.presenceScope !== presenceScope ||
    !(await preflight.prepared.keysetCurrent)
  )
    throw new ScanAttemptRaced();
  const { passFence } = preflight;
  const read =
    accessGate && found.access
      ? { ...preflight.observed, gateBefore: found.access.gateBefore }
      : preflight.observed;
  // At a tracked zone the signed effect is the place's row (read with the zones), not a snapshot scope.
  const placed = place
    ? occupancyEffect(place, {
        orgId: actor.orgId,
        passId: found.pass.id,
        scanId,
        now,
        keep:
          place.inside &&
          place.spec.kind === 'zone' &&
          place.spec.zone.occupancy === 'track' &&
          override?.reason !== 'still_inside',
      })
    : null;
  const observed = placed ? { ...read, presenceBefore: placed.presenceBefore } : read;
  const previousGate = observed.gateBefore;
  if (
    (previousGate &&
      (previousGate.orgId !== actor.orgId ||
        previousGate.mode !== found.pass.mode ||
        previousGate.templateId !== found.pass.templateId ||
        previousGate.kind !== action.kind)) ||
    (observed.presenceBefore && observed.presenceBefore.orgId !== actor.orgId)
  )
    throw new ScanAttemptRaced();
  if (presencePlan && !snapshots.samePresence(presencePlan.presence, observed.presenceBefore))
    throw new ScanAttemptRaced();
  const state =
    action.kind === 'check_in'
      ? (place?.direction ?? found.admission?.state.direction ?? ('in' as const))
      : ('used' as const);
  assertTapOut(found, state);
  const seed = {
    ...gate,
    // At an event place the entry statement holds capacity itself, with the exact reason.
    ...(action.kind === 'check_in' &&
    !place &&
    event?.capacity != null &&
    found.admission?.state.direction !== 'out' &&
    (override?.reason !== 'capacity_full' || event.hardLimit === true)
      ? { capacity: { eventId: event.id, max: event.capacity, reentry: event.reentry } }
      : {}),
    orgId: actor.orgId,
    mode: found.pass.mode,
    templateId: found.pass.templateId,
    kind: action.kind,
    state,
    admission: presencePlan,
    ...(accessGate && found.access ? { accessVisit: startsVisit(found.access, now) } : {}),
    method: req.input.method,
    claimEventId: authorityActor.event?.id ?? null,
    idempotencyKey: req.idempotencyKey,
    requestHash,
    credentialTombstoneRefs,
    credentialKeysetCommitment,
    scanId,
    claimAt,
    now,
  };
  const claimed = snapshots.claimEffect(observed, seed);
  const effect = placed ? { ...claimed, presenceAfter: placed.presenceAfter } : claimed;
  const claim: gates.GateClaim = {
    ...seed,
    presenceScope,
    effect,
    authority: {
      actor: authorityActor,
      pass: found.pass,
      passFence,
      event,
      approvedBy,
      approvedAuthEpoch,
      override,
    },
    gate:
      accessGate ||
      place ||
      (override && (override.reason === 'already_done' || override.reason === 'cooldown'))
        ? { rule: 'always' }
        : action.kind === 'check_in' && (found.checkInRules?.mode || actor.settings.checkIn?.mode)
          ? { rule: 'always' }
          : gateRule(action),
  };
  const facts = {
    pass: found.pass,
    scanId,
    action,
    method: req.input.method,
    override: override !== null,
    approvedBy,
    direction: place?.direction ?? found.admission?.state.direction,
    place: presenceScope,
  };
  const stopAuthority = {
    actor: authorityActor,
    event,
    templateId: found.pass.templateId,
    passFence,
    approvedBy,
    approvedAuthEpoch,
  };
  const capacityRequired = !!seed.capacity;
  if (capacityRequired && held.capacityFull === null) throw new StaleScanAuthority();
  if (
    (capacityRequired && held.capacityFull === true) ||
    gateWasHeld(observed.gateBefore, claim.gate, now)
  )
    return finishHeldGate({
      ctx,
      actor,
      found,
      action,
      scanId,
      claimAt,
      credentialKeysetCommitment,
      gate,
      claim,
      observed,
      stopAuthority,
      holderResult: held.holder,
      capacityRequired,
      capacityFull: held.capacityFull === true,
      history: history?.preloaded,
      photo,
      facts,
      dayStart: req.dayStart,
      reservation,
      onFailureCommitted,
    });
  if (action.kind !== 'check_in') {
    const approver =
      approvedBy && approvedAuthEpoch !== null
        ? { id: approvedBy, authEpoch: approvedAuthEpoch, deskOk: input.approvedRole === 'desk' }
        : null;
    const outcome = await commitValue({
      ctx,
      actor,
      found,
      req,
      reservation,
      action,
      undoWindow,
      gate,
      claim,
      stopAuthority,
      originalCandidate,
      facts,
      approver,
      onFailureCommitted,
    });
    if (outcome.kind === 'ok' && !outcome.replay)
      deferTermStart({ ctx, actor, found, req, action, claim, originalCandidate, approver });
    return outcome;
  }
  return commitCheckInSuccess({
    ctx,
    actor,
    found,
    req,
    history,
    photo,
    reservation,
    action,
    undoWindow,
    gate,
    claim,
    presencePlan,
    stopAuthority,
    originalCandidate,
    facts,
    approver:
      approvedBy && approvedAuthEpoch !== null
        ? { id: approvedBy, authEpoch: approvedAuthEpoch, deskOk: input.approvedRole === 'desk' }
        : null,
    onFailureCommitted,
  });
}
