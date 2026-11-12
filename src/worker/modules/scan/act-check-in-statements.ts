import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { Grant } from '../../platform/authority.ts';
import { type GrantCond, not } from '../../platform/authority-cond.ts';
import type { EventRow } from '../events/repo.ts';
import type { AdmissionPlan } from './admission-types.ts';
import type * as gates from './repo-gates.ts';
import { holderPart, presenceHolderPart } from './repo-scan-checks.ts';
import { retentionProofIfRecordedStmt } from './repo-scan-retention.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';
import { retentionPart, scanIs, wonGate } from './scan-write-grant.ts';
import {
  allOf,
  type Finalize,
  finalizeScan,
  holdsPresence,
  ledgerEvent,
  overrideOpen,
  writeGate,
  writePresence,
} from './scan-write-statements.ts';

/** One pre-signed ledger row and its retention proof, for one way the scan can close. */
interface CheckInVariant {
  row: EventRow;
  retention: PreparedScanRetentionProof;
}

interface CheckInStatementsInput {
  gate: gates.GateKey;
  claim: gates.GateClaim;
  /** The clock the gate rule is judged at. */
  at: number;
  presencePlan: AdmissionPlan | undefined;
  overrideOf: string | null;
  capacity: GrantCond | null;
  /** What let the scan in, and the heads-up when another scan took it first. */
  admitted: { conds: GrantCond[]; reason: ScanReason };
  lost: ScanReason;
  finalized(outcome: 'ok' | 'heads_up', reason: ScanReason | null): Finalize;
  variants: {
    ok: CheckInVariant;
    admit: CheckInVariant | null;
    cap: CheckInVariant | null;
    lost: CheckInVariant;
  };
  sideDb: D1Database;
}

/**
 * The commit grant's writes: the gate (only while the admission and override still hold), presence,
 * one finalize per way the scan can close (the first that applies wins), their ledger rows and proofs,
 * and the holders a heads-up names.
 */
export function addCheckInStatements(g: Grant, i: CheckInStatementsInput) {
  const { gate, claim, presencePlan, overrideOf, capacity, admitted, lost, finalized } = i;
  const { scanId, effect } = claim;
  const gateAfter = effect.gateAfter;
  if (!gateAfter) return null;
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
      at: i.at,
      before: effect.gateBefore,
      after: gateAfter,
    },
    [...(capacity ? [capacity] : []), ...admitted.conds],
  );
  const presence = presencePlan && effect.presenceAfter;
  if (presence) writePresence(g, gate, scanId, effect.presenceBefore, presence);
  const finalOk = finalizeScan(g, finalized('ok', null), [
    wonGate(gate, scanId),
    ...(presence ? [holdsPresence(gate.passId, presence.scope, scanId)] : []),
    ...(overrideOf ? [overrideOpen(overrideOf)] : []),
  ]);
  const finalAdmit = admitted.conds.length
    ? finalizeScan(g, finalized('heads_up', admitted.reason), [not(allOf(admitted.conds))])
    : null;
  const finalCap =
    i.variants.cap && capacity
      ? finalizeScan(g, finalized('heads_up', 'capacity_full'), [not(capacity)])
      : null;
  finalizeScan(g, finalized('heads_up', lost));
  for (const [v, outcome, reason] of [
    [i.variants.ok, 'ok', null],
    [i.variants.admit, 'heads_up', admitted.reason],
    [i.variants.cap, 'heads_up', 'capacity_full'],
    [i.variants.lost, 'heads_up', lost],
  ] as const) {
    if (!v) continue;
    ledgerEvent(g, v.row, scanId, outcome, reason);
    g.include(retentionPart(retentionProofIfRecordedStmt(i.sideDb, v.retention)));
  }
  const [holder] = g.include(holderPart(gate));
  const [presenceHolder] = presence
    ? g.include(presenceHolderPart(gate.passId, presence.scope))
    : [];
  g.assert('stale', [scanIs(scanId, { state: 'done' })]);
  return { finalOk, finalAdmit, finalCap, holder, presenceHolder };
}
