import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { Grant, GrantedStatement } from '../../platform/authority.ts';
import { exists, type GrantCond, notExists } from '../../platform/authority-cond.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import { lostReason } from './act-check-in-facts.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ScanActor } from './actor.ts';
import { type LedgerFacts, ledgerRow } from './ledger.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import type * as gates from './repo-gates.ts';
import { holderPart } from './repo-scan-checks.ts';
import * as snapshots from './repo-scan-effect.ts';
import { retentionProofPart } from './repo-scan-retention-part.ts';
import type { Found } from './resolve.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import { scanIs, wonGate } from './scan-write-grant.ts';
import { type Finalize, finalizeScan, ledgerEvent, writeGate } from './scan-write-statements.ts';

/** What every closing of a value scan shares. */
export interface ValueScan {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  action: ResolvedScanAction;
  claim: gates.GateClaim;
  gate: gates.GateKey;
  stopAuthority: StopAuthority;
  facts: Omit<LedgerFacts, 'outcome' | 'reason'>;
  approvedBy: string | null;
  eventId: string | null;
}

/**
 * The pass write was never applied while this holds: the gate is not the row the scan saw. A
 * cooldown or once gate must still be that row; an `always` gate never blocks.
 */
export function gateUnchanged(claim: gates.GateClaim): GrantCond[] {
  if (claim.gate.rule === 'always') return [];
  const key = { pass_id: claim.passId, action_id: claim.actionId, scope: claim.scope };
  const before = claim.effect.gateBefore;
  return [
    before
      ? exists('scan_gates', { ...key, last_scan_id: before.lastScanId, state: before.state })
      : notExists('scan_gates', key),
  ];
}

const variantOf = async (
  s: ValueScan,
  outcome: 'ok' | 'heads_up',
  reason: ScanReason | null,
  pass: Pass,
) => {
  const { ctx, actor, found, action, claim, gate, stopAuthority, facts } = s;
  const held = outcome === 'heads_up';
  const effect = held
    ? {
        ...claim.effect,
        gateAfter: claim.effect.gateBefore,
        presenceAfter: claim.effect.presenceBefore,
      }
    : claim.effect;
  const row = await ledgerAuthoritySnapshot(
    ctx,
    ledgerRow(ctx, actor, {
      ...facts,
      pass,
      outcome,
      reason,
      ...(held ? { override: false, approvedBy: null } : {}),
    }),
    found.pass,
    stopAuthority,
    {
      claimAt: claim.claimAt,
      credentialKeysetCommitment: claim.credentialKeysetCommitment,
      direction: null,
      presenceScope: null,
      found,
      action,
      gate: snapshots.effectGate(gate.scope, held ? effect.gateBefore : effect.gateAfter),
      effect,
      gateScope: gate.scope,
    },
  );
  const retention = await prepareScanRetentionProof(ctx.env, row, actor.actorKey, {
    actionId: action.id,
  });
  return { row, retention };
};

export interface ValueStatements {
  finalOk: GrantedStatement;
  holder: GrantedStatement;
  lost: ScanReason;
}

/**
 * The scan's own rows in the pass write's batch, each guarded by `passWon`: the gate, the scan
 * closed `ok`, its ledger event and proof. When the pass write was skipped (the gate moved) the
 * scan closes as the heads-up of the gate it lost instead, and nothing else changed.
 */
export async function addValueStatements(
  g: Grant,
  s: ValueScan,
  passWon: GrantCond,
  pass: Pass,
  /** The input's change, as the scan row records it. */
  value: NonNullable<Finalize['value']>,
): Promise<ValueStatements> {
  const { claim, gate, found, action } = s;
  const { scanId, claimAt, effect } = claim;
  const gateAfter = effect.gateAfter;
  if (!gateAfter) throw new Error('A value scan has a gate effect.');
  const lost = lostReason(claim.gate);
  const [ok, held] = await Promise.all([
    variantOf(s, 'ok', null, pass),
    variantOf(s, 'heads_up', lost, found.pass),
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
    passVersion: outcome === 'ok' ? pass.version : found.pass.version,
    overrideOf: null,
    approvedBy: outcome === 'ok' ? s.approvedBy : null,
    ...(s.eventId ? { eventId: s.eventId } : {}),
    ...(outcome === 'ok' ? { value } : {}),
  });
  writeGate(
    g,
    {
      ...gate,
      templateId: claim.templateId,
      kind: claim.kind,
      scanId,
      rule: claim.gate,
      at: s.ctx.clock.now(),
      before: effect.gateBefore,
      after: gateAfter,
      takeOver: claim.gate.rule === 'always',
    },
    [passWon],
  );
  const finalOk = finalizeScan(g, finalized('ok', null), [wonGate(gate, scanId), passWon]);
  finalizeScan(g, finalized('heads_up', lost));
  for (const [v, outcome, reason] of [
    [ok, 'ok', null],
    [held, 'heads_up', lost],
  ] as const) {
    ledgerEvent(g, v.row, scanId, outcome, reason);
    g.include(retentionProofPart(v.retention));
  }
  const [holder] = g.include(holderPart(gate));
  g.assert('stale', [scanIs(scanId, { state: 'done' })]);
  if (!holder) throw new Error('A value scan reads its gate holder.');
  return { finalOk, holder, lost };
}
