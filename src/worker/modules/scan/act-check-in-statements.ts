import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { Grant } from '../../platform/authority.ts';
import type { GrantCond } from '../../platform/authority-cond.ts';
import type { EventRow } from '../events/repo.ts';
import type { Finalizer } from './act-check-in-finalize.ts';
import { addOccupancy, type OccupancyCommit } from './act-check-in-occupancy.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { type AccessGateWrite, startedVisit, writeAccessGate } from './repo-access.ts';
import type * as gates from './repo-gates.ts';
import { holderPart, presenceHolderPart } from './repo-scan-checks.ts';
import { retentionProofPart } from './repo-scan-retention-part.ts';
import type { PreparedScanRetentionProof } from './scan-retention-proof.ts';
import { scanIs, wonGate } from './scan-write-grant.ts';
import {
  finalizeScan,
  holdsPresence,
  ledgerEvent,
  overrideOpen,
  writeAdmissionRecord,
  writeGate,
} from './scan-write-statements.ts';

/** One pre-signed ledger row and its retention proof, for one way the scan can close. */
interface CheckInVariant {
  row: EventRow;
  retention: PreparedScanRetentionProof;
}

/** A heads-up the scan closes with when its condition holds (the first that applies wins). */
export interface HeldVariant {
  reason: ScanReason;
  /** A used-up guest is red wherever it is answered (AX); every other hold is a heads-up. */
  outcome?: 'heads_up' | 'refused';
  when: GrantCond[];
  /** Its own signed ledger row; null when it shares the `lost` reason's. */
  variant: CheckInVariant | null;
  /** Another scan admitted the pass first: the answer names that scan's holder. */
  admit?: boolean;
}

interface CheckInStatementsInput {
  gate: gates.GateKey;
  claim: gates.GateClaim;
  /** The clock the gate rule is judged at. */
  at: number;
  presencePlan: AdmissionPlan | undefined;
  overrideOf: string | null;
  capacity: GrantCond | null;
  /** What let the scan in (repeated in the gate write; another door wins). */
  admitted: { conds: GrantCond[] };
  lost: ScanReason;
  finalized: Finalizer;
  /** An Access card: the gate counts visits instead of taking the first scan. */
  access: Omit<AccessGateWrite, 'passId' | 'scanId' | 'at'> | null;
  /** A check-in at a tracked zone: the in/out row decides, and the gate follows it. */
  occupancy: OccupancyCommit | null;
  variants: { ok: CheckInVariant; held: HeldVariant[]; lost: CheckInVariant };
}

/**
 * The commit grant's writes: the place (a tracked zone's entry or exit), the gate (only while the
 * admission, override and place still hold), presence, one finalize per way the scan can close (the
 * first that applies wins), their ledger rows and proofs, and the holders a heads-up names.
 */
export function addCheckInStatements(g: Grant, i: CheckInStatementsInput) {
  const { gate, claim, presencePlan, overrideOf, capacity, admitted, lost, finalized } = i;
  const { scanId, effect } = claim;
  const gateAfter = effect.gateAfter;
  const occ = i.occupancy;
  if (!gateAfter) return null;
  // At a tracked zone the in/out row decides first; the gate follows only if it moved. An exit
  // takes the action's own gate, never the visit gate: no visit, no wait (OC4).
  const moved = occ ? addOccupancy(g, occ) : null;
  const guards = moved ? [moved.won] : [...(capacity ? [capacity] : []), ...admitted.conds];
  if (i.access) writeAccessGate(g, { ...i.access, passId: gate.passId, scanId, at: i.at }, guards);
  else
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
      guards,
    );
  const presence = !occ && presencePlan && effect.presenceAfter;
  if (presence) writeAdmissionRecord(g, gate, scanId, effect.presenceBefore, presence);
  const won = [
    ...(moved ? [moved.won] : []),
    wonGate(gate, scanId),
    ...(presence ? [holdsPresence(gate.passId, presence.scope, scanId)] : []),
    ...(overrideOf ? [overrideOpen(overrideOf)] : []),
  ];
  // The grant that started a visit is closed first; the rest of the winners are inside one.
  const finalVisit = i.access
    ? finalizeScan(g, finalized('ok', null, true), [
        ...won,
        startedVisit({ ...i.access, passId: gate.passId, scanId, at: i.at }),
      ])
    : null;
  const finalOk = finalizeScan(g, finalized('ok', null, false), won);
  const held = i.variants.held.map((h) => ({
    ...h,
    statement: finalizeScan(g, finalized(h.outcome ?? 'heads_up', h.reason), h.when),
  }));
  finalizeScan(g, finalized('heads_up', lost));
  for (const [v, outcome, reason] of [
    [i.variants.ok, 'ok', null],
    ...held.map((h) => [h.variant, h.outcome ?? 'heads_up', h.reason] as const),
    [i.variants.lost, 'heads_up', lost],
  ] as const) {
    if (!v) continue;
    ledgerEvent(g, v.row, scanId, outcome, reason);
    g.include(retentionProofPart(v.retention));
  }
  const [holder] = g.include(holderPart(gate));
  const [presenceHolder] = presence
    ? g.include(presenceHolderPart(gate.passId, presence.scope))
    : [];
  g.assert('stale', [scanIs(scanId, { state: 'done' })]);
  return { finalOk, finalVisit, held, holder, presenceHolder };
}
