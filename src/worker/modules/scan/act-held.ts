import type { ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { not } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { prepareCommittedDisplay } from './act-display.ts';
import { type HeldHolder, heldGateHolder } from './act-held-holder.ts';
import { StaleScanAuthority } from './act-override.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ActorCsrfSnapshot } from './actor-csrf.ts';
import { type CountsRead, planCommitCounts } from './counts.ts';
import { cardPrivacy } from './dto-projection.ts';
import type { ScanActor } from './guard.ts';
import { type PreloadedDisplayHistory, rebindDisplayHistoryRead } from './history-proof-plan.ts';
import { type LedgerFacts, ledgerRow, recordResult } from './ledger.ts';
import type { PreparedPhotoGrant } from './member-photo.ts';
import { blankOutcome, canOverride, safeOutcomeDetails } from './outcome.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import * as gates from './repo-gates.ts';
import type { Candidate } from './repo-lookup.ts';
import * as snapshots from './repo-scan-effect.ts';
import { retentionProofIfRecordedStmt } from './repo-scan-retention.ts';
import { activeFlags, type Found } from './resolve.ts';
import { capturingDb } from './scan-capture.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import {
  capacityOpen,
  doneScanPredicate,
  refundPin,
  retentionPart,
  SCAN_HELD_TABLES,
  scanIs,
  scanWriteGrant,
} from './scan-write-grant.ts';
import { finalizeScan, ledgerEvent } from './scan-write-statements.ts';
import type { PinReservation } from './staff-pin.ts';

export interface HeldGateInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  action: ResolvedScanAction;
  scanId: string;
  claimAt: number;
  credentialKeysetCommitment: string;
  gate: gates.GateKey;
  claim: gates.GateClaim;
  observed: snapshots.ObservedScanEffect;
  stopAuthority: StopAuthority;
  holderResult: D1Result;
  capacityRequired: boolean;
  capacityFull: boolean;
  history?: PreloadedDisplayHistory;
  photo: PreparedPhotoGrant | null;
  csrfSnapshot: ActorCsrfSnapshot;
  originalCandidate: Candidate | null;
  facts: Omit<LedgerFacts, 'outcome' | 'reason'>;
  dayStart?: number;
  reservation: PinReservation | null;
  onFailureCommitted(): void;
}

interface HeldOutcomeInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  action: ResolvedScanAction;
  scanId: string;
  reason: ScanReason;
  holder: HeldHolder | undefined;
  read: CountsRead;
  display: ScanDisplay | null;
  now: number;
}

/** The truthful heads-up for a gate that someone else holds (or an event that is full). */
export function heldOutcome(i: HeldOutcomeInput): ScanOutcome {
  const { ctx, actor, found, action, holder, read, reason } = i;
  recordResult(ctx, actor, found.pass.templateId, reason);
  const details = safeOutcomeDetails(
    found,
    actor,
    action,
    activeFlags(found, actor).map((flag) => flag.label),
  );
  const holderPrivacy = holder?.scan_id ? cardPrivacy(found, actor) : null;
  const remaining =
    reason === 'cooldown' && holder
      ? Math.max(0, holder.last_at + (action.cooldownMinutes ?? 5) * 60_000 - i.now)
      : null;
  return {
    ...blankOutcome('heads_up', read),
    scanId: i.scanId,
    reason,
    action: details.action,
    template: details.template,
    at: holder?.at ?? null,
    cooldownRemainingMs: remaining,
    previous: holder?.scan_id
      ? {
          scanId: holder.scan_id,
          at: holder.at,
          scannerName:
            holder.scanner_name && holderPrivacy?.safe(holder.scanner_name)
              ? holder.scanner_name
              : 'Scanner',
          staffName:
            holder.staff_name && holderPrivacy?.safe(holder.staff_name) ? holder.staff_name : null,
          actionLabel: details.action?.label ?? 'Scan',
          override: holder.override_of !== null,
        }
      : null,
    overridable: canOverride(actor, reason, action, read.approvals),
    display: i.display,
  };
}

/** A preflight-held gate is recorded without a gate write: one grant batch closes the scan as a heads-up. */
export async function finishHeldGate(input: HeldGateInput): Promise<ScanOutcome> {
  const { ctx, actor, found, action, scanId, claimAt, gate, claim, observed, holderResult } = input;
  const { capacityRequired, capacityFull, history, photo, csrfSnapshot, originalCandidate } = input;
  const { facts, reservation, stopAuthority, onFailureCommitted } = input;
  const event = actor.event;
  const holder = heldGateHolder(holderResult, observed);
  const reason: ScanReason =
    capacityRequired && capacityFull
      ? 'capacity_full'
      : holder?.scan_state === 'pending'
        ? 'in_progress'
        : action.repeat === 'cooldown'
          ? 'cooldown'
          : 'already_done';
  const side = { ...ctx, env: { ...ctx.env, DB: capturingDb(ctx.env.DB) } };
  if (history && !rebindDisplayHistoryRead(history, actor, found)) throw new StaleScanAuthority();
  const heldEffect = {
    ...observed,
    gateAfter: observed.gateBefore,
    presenceAfter: observed.presenceBefore,
  };
  const row = await ledgerAuthoritySnapshot(
    ctx,
    ledgerRow(ctx, actor, {
      ...facts,
      outcome: 'heads_up',
      reason,
      override: false,
      approvedBy: null,
    }),
    found.pass,
    stopAuthority,
    {
      claimAt,
      credentialKeysetCommitment: input.credentialKeysetCommitment,
      direction: found.admission?.state.direction ?? null,
      presenceScope: null,
      found,
      action,
      gate: snapshots.effectGate(gate.scope, observed.gateBefore),
      effect: heldEffect,
      gateScope: gate.scope,
    },
  );
  const retention = await prepareScanRetentionProof(ctx.env, row, actor.actorKey, {
    actionId: action.id,
  });
  const display = await prepareCommittedDisplay(
    side,
    actor,
    found,
    stopAuthority.actor,
    'heads_up',
    photo,
    csrfSnapshot,
    originalCandidate,
    history,
  );
  const now = ctx.clock.now();
  const g = scanWriteGrant(ctx, stopAuthority.actor, {
    purpose: 'org_mode.scan.held',
    now,
    event: event ?? null,
    tables: SCAN_HELD_TABLES,
    pass: { id: found.pass.id, facts: { pass: found.pass, credential: {} } },
    holder: observed.gateBefore ? { ...gate, lastScanId: observed.gateBefore.lastScanId } : null,
    // Another pass's transfer can retire the presented credential after resolve (shared hash).
    credentialRefs: { current: claim.credentialTombstoneRefs, other: [] },
  });
  if (capacityRequired && claim.capacity)
    g.assert('stale', [
      capacityFull
        ? not(
            capacityOpen(
              gates.capacityFullPredicate(
                claim.orgId,
                claim.mode,
                claim.capacity.eventId,
                claim.capacity.max,
                claim.capacity.reentry,
                claim.passId,
              ),
            ),
          )
        : capacityOpen(
            gates.capacityFullPredicate(
              claim.orgId,
              claim.mode,
              claim.capacity.eventId,
              claim.capacity.max,
              claim.capacity.reentry,
              claim.passId,
            ),
          ),
    ]);
  const finalized = finalizeScan(g, {
    id: scanId,
    claimAt,
    outcome: 'heads_up',
    reason,
    passId: found.pass.id,
    templateId: found.pass.templateId,
    actionId: action.id,
    actionKind: action.kind,
    passVersion: found.pass.version,
    overrideOf: null,
    approvedBy: null,
    direction: found.admission?.state.direction,
    ...(event ? { eventId: event.id } : {}),
  });
  ledgerEvent(g, row, scanId, 'heads_up', reason);
  g.include(retentionPart(retentionProofIfRecordedStmt(side.env.DB, retention)));
  g.assert('stale', [scanIs(scanId, { state: 'done' })]);
  const counts = planCommitCounts(ctx, actor, input.dayStart);
  const bound = display.bind(ctx.clock.now(), doneScanPredicate(scanId));
  const committed = await g.commitWith([...counts.stmts, ...bound.stmts]);
  const results = committed.writes;
  await refundPin(ctx, reservation);
  if (!((results[g.indexOf(finalized)]?.results ?? []) as unknown[]).length) {
    onFailureCommitted();
    throw new StaleScanAuthority();
  }
  // Recorded with its counts and card reads, in the commit's transaction.
  const finishAt = ctx.clock.now();
  const read = await counts.read(committed.after.slice(0, counts.stmts.length));
  return heldOutcome({
    ctx,
    actor,
    found,
    action,
    scanId,
    reason,
    holder,
    read,
    display: bound.finish(committed.after.slice(counts.stmts.length)),
    now: finishAt,
  });
}
