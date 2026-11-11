import type { Mode } from '../../../shared/contracts/common.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { AdmissionPlan } from './admission-types.ts';
import type { GateClaim, GateKey } from './repo-gates.ts';

export type { ObservedScanEffect } from './repo-scan-effect-snapshots.ts';
export {
  effectPredicate,
  gateSnapshotPredicate,
  presenceSnapshot,
  presenceSnapshotPredicate,
  readScanEffect,
  readScanEffectStmt,
  samePresence,
  scanEffectFromResult,
} from './repo-scan-effect-snapshots.ts';

/** Complete persisted state, including the current gate holder's scan state. */
export interface ScanGateSnapshot {
  passId: string;
  actionId: string;
  scope: string;
  orgId: string;
  mode: Mode;
  templateId: string;
  kind: string;
  state: string;
  count: number;
  firstAt: number;
  lastAt: number;
  lastScanId: string;
  prevState: string | null;
  prevLastAt: number | null;
  prevScanId: string | null;
  holderState: string | null;
  holderUndoneBy: string | null;
}

export interface ScanPresenceSnapshot {
  passId: string;
  orgId: string;
  scope: string;
  state: 'in' | 'out';
  tracking: number;
  enteredAt: number | null;
  firstAt: number;
  lastEntryAt: number;
  lastScanId: string;
  prevState: string | null;
  prevTracking: number | null;
  prevEnteredAt: number | null;
  prevFirstAt: number | null;
  prevLastEntryAt: number | null;
  prevScanId: string | null;
}

export interface ScanEffectSnapshot {
  gateBefore: ScanGateSnapshot | null;
  gateAfter: ScanGateSnapshot | null;
  presenceBefore: ScanPresenceSnapshot | null;
  presenceAfter: ScanPresenceSnapshot | null;
}

export type ScanSignedGateSnapshot = Omit<ScanGateSnapshot, 'actionId'> & { actionIdRef: string };
export interface ScanSignedEffectSnapshot {
  gateBefore: ScanSignedGateSnapshot | null;
  gateAfter: ScanSignedGateSnapshot | null;
  presenceBefore: ScanPresenceSnapshot | null;
  presenceAfter: ScanPresenceSnapshot | null;
}

/** Keep raw action IDs in memory only; the event records their keyed reference. */
export function signedEffectSnapshot(
  effect: ScanEffectSnapshot,
  actionIdRef: string | null,
): ScanSignedEffectSnapshot {
  const actionId = effect.gateAfter?.actionId ?? effect.gateBefore?.actionId;
  const signedGate = (gate: ScanGateSnapshot | null): ScanSignedGateSnapshot | null => {
    if (!gate) return null;
    const { actionId: gateActionId, ...snapshot } = gate;
    if (!actionIdRef || gateActionId !== actionId)
      throw new Error('Invalid signed gate action reference');
    return { ...snapshot, actionIdRef };
  };
  return {
    gateBefore: signedGate(effect.gateBefore),
    gateAfter: signedGate(effect.gateAfter),
    presenceBefore: effect.presenceBefore,
    presenceAfter: effect.presenceAfter,
  };
}

export interface ScanGateEventProjection {
  scope: string;
  exists: boolean;
  orgId: string | null;
  mode: Mode | null;
  templateId: string | null;
  kind: string | null;
  scanId: string | null;
  state: string | null;
  count: number | null;
  firstAt: number | null;
  lastAt: number | null;
  prevState: string | null;
  prevLastAt: number | null;
  prevScanId: string | null;
  scanState: string | null;
  undoneBy: string | null;
}

/** Authenticate the gate projection alongside the complete transition. */
export function effectGate(scope: string, gate: ScanGateSnapshot | null): ScanGateEventProjection {
  return {
    scope,
    exists: gate !== null,
    orgId: gate?.orgId ?? null,
    mode: gate?.mode ?? null,
    templateId: gate?.templateId ?? null,
    kind: gate?.kind ?? null,
    scanId: gate?.lastScanId ?? null,
    state: gate?.state ?? null,
    count: gate?.count ?? null,
    firstAt: gate?.firstAt ?? null,
    lastAt: gate?.lastAt ?? null,
    prevState: gate?.prevState ?? null,
    prevLastAt: gate?.prevLastAt ?? null,
    prevScanId: gate?.prevScanId ?? null,
    scanState: gate?.holderState ?? null,
    undoneBy: gate?.holderUndoneBy ?? null,
  };
}

/** Predict the exact row values that the UPSERT and presence statement will write. */
export function claimEffect(
  before: Pick<ScanEffectSnapshot, 'gateBefore' | 'presenceBefore'>,
  claim: GateKey & {
    orgId: string;
    mode: Mode;
    templateId: string;
    kind: string;
    state: 'in' | 'out' | 'used';
    scanId: string;
    now: number;
    admission?: AdmissionPlan;
  },
): ScanEffectSnapshot {
  const g = before.gateBefore;
  const p = before.presenceBefore;
  const gateAfter: ScanGateSnapshot = {
    passId: claim.passId,
    actionId: claim.actionId,
    scope: claim.scope,
    orgId: g?.orgId ?? claim.orgId,
    mode: g?.mode ?? claim.mode,
    templateId: g?.templateId ?? claim.templateId,
    kind: g?.kind ?? claim.kind,
    state: claim.state,
    count: (g?.count ?? 0) + 1,
    firstAt: g?.firstAt ?? claim.now,
    lastAt: claim.now,
    lastScanId: claim.scanId,
    prevState: g?.state ?? null,
    prevLastAt: g?.lastAt ?? null,
    prevScanId: g?.lastScanId ?? null,
    holderState: 'done',
    holderUndoneBy: null,
  };
  const a = claim.admission;
  const presenceAfter: ScanPresenceSnapshot | null = a
    ? {
        passId: claim.passId,
        orgId: p?.orgId ?? claim.orgId,
        scope: a.scope,
        state: a.state.direction,
        tracking: a.tracked ? 1 : 0,
        enteredAt: a.state.direction === 'in' ? claim.now : null,
        firstAt: p?.firstAt ?? a.state.firstAt ?? claim.now,
        lastEntryAt: a.state.direction === 'in' || !p ? claim.now : p.lastEntryAt,
        lastScanId: claim.scanId,
        prevState: p?.state ?? null,
        prevTracking: p?.tracking ?? null,
        prevEnteredAt: p?.enteredAt ?? null,
        prevFirstAt: p?.firstAt ?? null,
        prevLastEntryAt: p?.lastEntryAt ?? null,
        prevScanId: p?.lastScanId ?? null,
      }
    : p;
  return { ...before, gateAfter, presenceAfter };
}

type Predicate = { sql: string; params: SqlValue[] };

export function credentialSnapshotMatches(
  input: { code: string } | { passId: string },
  refs: readonly string[],
  evaluated: readonly string[],
): boolean {
  return (
    Array.isArray(refs) &&
    Array.isArray(evaluated) &&
    refs.length === evaluated.length &&
    refs.every((ref, index) => ref === evaluated[index]) &&
    ('code' in input ? refs.length > 0 : refs.length === 0)
  );
}

export function andEffectFences(left: Predicate, right: Predicate): Predicate {
  return { sql: `(${left.sql}) AND (${right.sql})`, params: [...left.params, ...right.params] };
}

/** Bind the durable intent and every original pending-claim identity field. */
export function pendingEffectPredicate(claim: GateClaim, beforeIntent = false): Predicate {
  const actor = claim.authority.actor;
  return {
    sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id=?/* scan-ephemeral-scan-id */ AND q.state='pending' AND q.reason ${beforeIntent ? 'IS NULL' : "= 'stale'"}
      AND q.at=? AND q.org_id=? AND q.mode=? AND q.actor_key=?/* scan-ephemeral-actor-key */
      AND q.scanner_id IS ?/* scan-ephemeral-scanner-id */ AND q.staff_id IS ?/* scan-ephemeral-staff-id */
      AND q.actor_type=? AND q.actor_id=?/* scan-ephemeral-actor-id */ AND q.method=?
      AND q.event_id IS ?/* scan-ephemeral-event-id */ AND q.idempotency_key=?/* scan-ephemeral-idempotency-key */
      AND q.request_hash=?/* scan-ephemeral-request-hash */)`,
    params: [
      claim.scanId,
      claim.claimAt,
      claim.orgId,
      claim.mode,
      actor.actorKey,
      actor.scanner?.id ?? null,
      actor.staff?.id ?? null,
      actor.actor.type,
      actor.actor.id,
      claim.method,
      claim.claimEventId,
      claim.idempotencyKey,
      claim.requestHash,
    ],
  };
}

export function pendingEffectFence(fence: Predicate, claim: GateClaim): Predicate {
  const pending = pendingEffectPredicate(claim);
  return {
    sql: `(${fence.sql}) AND (${pending.sql})`,
    params: [...fence.params, ...pending.params],
  };
}

/** Keep the finalized idempotency identity bound through the response fence. */
export function recordedClaimFence(fence: Predicate, claim: GateClaim): Predicate {
  return {
    sql: `(${fence.sql}) AND EXISTS (SELECT 1 FROM scans q
      WHERE q.id=?/* scan-ephemeral-scan-id */ AND q.idempotency_key=?/* scan-ephemeral-idempotency-key */ AND q.request_hash=?/* scan-ephemeral-request-hash */)`,
    params: [...fence.params, claim.scanId, claim.idempotencyKey, claim.requestHash],
  };
}

/** Keep verified CSRF material in scalar binds, outside packed predicates. */
export function csrfFenceStmt(
  db: D1Database,
  fence: { sql: string; params: readonly SqlValue[] },
  abortOnMismatch: boolean,
): D1PreparedStatement {
  const mismatch = abortOnMismatch ? "json_extract('[]', '$[scan_effect_incomplete]')" : '0';
  return stmt(
    db,
    `SELECT CASE WHEN (${fence.sql}) THEN 1 ELSE ${mismatch} END AS valid`,
    fence.params,
  );
}

/** Abort rather than commit a gate without its signed ledger and retention proof. */
export function requireRecordedEffectStmt(
  db: D1Database,
  gate: GateKey,
  scanId: string,
  requiredWhen?: { sql: string; params: readonly SqlValue[] },
): D1PreparedStatement {
  const when = requiredWhen ?? { sql: '1', params: [] };
  return stmt(
    db,
    `SELECT CASE WHEN changes()<>1 AND (${when.sql}) AND EXISTS (SELECT 1 FROM scan_gates
    WHERE pass_id=?/* scan-ephemeral-pass-id */ AND action_id=?/* scan-ephemeral-action-id */ AND scope=?/* scan-ephemeral-event-scope */ AND last_scan_id=?/* scan-ephemeral-scan-id */)
    THEN json_extract('[]', '$[scan_effect_incomplete]') ELSE 1 END AS complete`,
    [...when.params, gate.passId, gate.actionId, gate.scope, scanId],
  );
}

/** A finalized stop must also have its signed ledger and retention proof. */
export function requireRecordedStopStmt(
  db: D1Database,
  scanId: string,
  claimAt: number,
  outcome: 'heads_up' | 'refused',
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT CASE WHEN changes()<>1 AND EXISTS (SELECT 1 FROM scans
    WHERE id=? AND at=? AND state='done' AND outcome=?)
    THEN json_extract('[]', '$[scan_effect_incomplete]') ELSE 1 END AS complete`,
    [scanId, claimAt, outcome],
  );
}

/** A transaction observed an incomplete effect and rolled it back. */
export class ObservedScanAmbiguity extends Error {
  constructor(cause: Error) {
    super('Scan effect could not be committed', { cause });
  }
}

export async function effectBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes('scan_effect_incomplete'))
      throw new ObservedScanAmbiguity(error);
    throw error;
  }
}
