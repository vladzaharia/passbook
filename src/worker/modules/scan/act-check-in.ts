import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { commitCheckInSuccess } from './act-check-in-success.ts';
import type { ActRequest } from './act-claim.ts';
import { gateWasHeld, type HeldGateSnapshot } from './act-gate-preflight.ts';
import { finishHeldGate } from './act-held.ts';
import { type Override, StaleScanAuthority } from './act-override.ts';
import type { ActionHistoryPreflight, ActionPreflight } from './act-preflight.ts';
import { snapshotActionContext, snapshotActionFound } from './act-snapshot.ts';
import { ScanAttemptRaced } from './act-stale-refusal.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { gateRule, gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import type * as gates from './repo-gates.ts';
import * as snapshots from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import { cloneObservedScanActor } from './scanning-workspace-observation.ts';
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
  csrfSnapshot: ActorCsrfSnapshot;
  preflight: ActionPreflight;
  held: HeldGateSnapshot;
  history: ActionHistoryPreflight | null;
  photo: PreparedPhotoGrant | null;
  undoWindow: number;
  found: Found;
  action: ResolvedScanAction;
  override: Override | null;
  approvedBy: string | null;
  approvedAuthEpoch: number | null;
  reservation: PinReservation | null;
  onFailureCommitted(): void;
}
export async function commitCheckIn(input: CommitInput): Promise<ScanOutcome> {
  const {
    ctx: originalCtx,
    actor: inputActor,
    authorityActor: inputAuthority,
    found: originalFound,
    req: originalReq,
    csrfSnapshot,
    preflight,
    held,
    history,
    photo,
    override,
    reservation,
    onFailureCommitted,
    ...source
  } = input;
  const ctx = snapshotActionContext(originalCtx);
  const actor = cloneObservedScanActor(inputActor);
  const authorityActor = cloneObservedScanActor(inputAuthority);
  const originalCandidate = originalFound.liveCandidate ?? null;
  const found = snapshotActionFound(originalFound);
  const { input: requestInput, approval, ...request } = originalReq;
  const req = {
    ...structuredClone(request),
    input: { ...requestInput },
    ...(approval ? { approval: { ...approval } } : {}),
  };
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
  } = structuredClone(source);
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
  const gate: gates.GateKey = {
    passId: found.pass.id,
    actionId: action.id,
    scope:
      found.admission && (found.checkInRules?.mode || actor.settings.checkIn?.mode)
        ? found.admission.scope
        : gateScope(action, actor, now),
  };
  if (!found.admission && event && (!found.eventAdmission || found.eventAdmissionReason))
    throw new StaleScanAuthority();
  const presencePlan = found.admission ?? found.eventAdmission;
  const presenceScope = presencePlan?.scope ?? gate.scope;
  // The preflight read no longer matches what was evaluated: another scan or edit moved the pass.
  if (
    preflight.gate.passId !== gate.passId ||
    preflight.gate.actionId !== gate.actionId ||
    preflight.gate.scope !== gate.scope ||
    preflight.presenceScope !== presenceScope ||
    !(await preflight.prepared.keysetCurrent)
  )
    throw new ScanAttemptRaced();
  const { passFence, observed } = preflight;
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
  const seed = {
    ...gate,
    ...(event?.capacity != null &&
    found.admission?.state.direction !== 'out' &&
    override?.reason !== 'capacity_full'
      ? { capacity: { eventId: event.id, max: event.capacity, reentry: event.reentry } }
      : {}),
    orgId: actor.orgId,
    mode: found.pass.mode,
    templateId: found.pass.templateId,
    kind: action.kind,
    state: found.admission?.state.direction ?? ('in' as const),
    admission: presencePlan,
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
  const effect = snapshots.claimEffect(observed, seed);
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
      adminEventTemplates: authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
    },
    gate:
      override && (override.reason === 'already_done' || override.reason === 'cooldown')
        ? { rule: 'always' }
        : found.checkInRules?.mode || actor.settings.checkIn?.mode
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
    direction: found.admission?.state.direction,
  };
  const stopAuthority = {
    actor: authorityActor,
    event,
    templateId: found.pass.templateId,
    adminEventTemplates: authorityActor.principal === 'admin' && !req.scope?.templateIds?.length,
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
      csrfSnapshot,
      originalCandidate,
      facts,
      dayStart: req.dayStart,
      reservation,
      onFailureCommitted,
    });
  return commitCheckInSuccess({
    ctx,
    actor,
    found,
    req,
    csrfSnapshot,
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
        ? { id: approvedBy, authEpoch: approvedAuthEpoch }
        : null,
    onFailureCommitted,
  });
}
