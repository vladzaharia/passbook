import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { HeldVariant } from './act-check-in-statements.ts';
import { ledgerAuthoritySnapshot } from './act-result-authority.ts';
import type { ScanActor } from './actor.ts';
import { type LedgerFacts, ledgerRow } from './ledger.ts';
import type * as gates from './repo-gates.ts';
import * as snapshots from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';
import { prepareScanRetentionProof } from './scan-retention-proof.ts';
import type { StopAuthority } from './scan-stop-authority.ts';

interface VariantInput {
  ctx: ServiceContext;
  actor: ScanActor;
  found: Found;
  action: ResolvedScanAction;
  facts: Omit<LedgerFacts, 'outcome' | 'reason'>;
  gate: gates.GateKey;
  claim: gates.GateClaim;
  presenceScope: string | null;
  stopAuthority: StopAuthority;
  /** The visit gate is `access`; the ledger names the action that was scanned (its signed reference). */
  accessGate: boolean;
}

/**
 * Sign one way a check-in can close: its ledger row and retention proof, made before the batch so
 * the grant only picks one. A heads-up shows the effect as it was read.
 */
export function checkInVariants(i: VariantInput) {
  const { ctx, actor, found, action, facts, gate, claim, stopAuthority } = i;
  const { effect, claimAt } = claim;
  const named = <T extends { actionId: string }>(g: T | null) =>
    g && i.accessGate ? { ...g, actionId: action.id } : g;
  return async (outcome: 'ok' | 'heads_up', reason: ScanReason | null) => {
    const held = outcome === 'heads_up';
    const gateAfter = held ? effect.gateBefore : effect.gateAfter;
    const moved = {
      ...effect,
      gateAfter,
      presenceAfter: held ? effect.presenceBefore : effect.presenceAfter,
    };
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
        direction: facts.direction ?? null,
        presenceScope: held ? null : i.presenceScope,
        found,
        action,
        gate: snapshots.effectGate(gate.scope, gateAfter),
        effect: e,
        gateScope: gate.scope,
      },
    );
    const retention = await prepareScanRetentionProof(ctx.env, row, actor.actorKey, {
      actionId: action.id,
    });
    return { row, retention };
  };
}

type Sign = ReturnType<typeof checkInVariants>;

/** Sign the ok row, the `lost` row and each held way's; a reason already signed shares that row. */
export async function signVariants(
  variant: Sign,
  lost: ScanReason,
  why: readonly Omit<HeldVariant, 'variant'>[],
) {
  const own = why.map(
    (h, at) => h.reason !== lost && why.findIndex((x) => x.reason === h.reason) === at,
  );
  const [ok, lostVariant, ...signed] = await Promise.all([
    variant('ok', null),
    variant('heads_up', lost),
    ...why.map((h, at) => (own[at] ? variant('heads_up', h.reason) : Promise.resolve(null))),
  ]);
  const held: HeldVariant[] = why.map((h, at) => ({ ...h, variant: signed[at] ?? null }));
  return { ok, lostVariant, held };
}
