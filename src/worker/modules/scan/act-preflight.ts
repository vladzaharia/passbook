import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type HeldGateSnapshot, heldGateReads } from './act-gate-preflight.ts';
import { gateScope } from './gate.ts';
import type { ScanActor } from './guard.ts';
import type { PendingDisplayHistorySource } from './history-proof-pending.ts';
import type { PreloadedDisplayHistory } from './history-proof-plan.ts';
import type * as gates from './repo-gates.ts';
import {
  type ActionPassFence,
  type PreparedActionPassFence,
  prepareActionPassFence,
} from './repo-pass-authority.ts';
import * as snapshots from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';

export interface ActionPreflight {
  gate: gates.GateKey;
  presenceScope: string;
  prepared: PreparedActionPassFence;
  passFence: ActionPassFence;
  observed: snapshots.ObservedScanEffect;
  /** Holder and capacity, read with the pass and effect: the commit's compare-and-swap proves them current. */
  held: HeldGateSnapshot;
}

export interface ActionHistoryPreflight {
  preloaded: PreloadedDisplayHistory;
  source: PendingDisplayHistorySource;
}

export interface ActionPreflightReadPlan {
  stmts: D1PreparedStatement[];
  finish(results: readonly (D1Result | { success: false })[]): Promise<void>;
  current(): ActionPreflight | null;
}

/** Prepare the original pass and effect reads to ride the admission transaction. */
export function prepareCheckInReads(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  action: ResolvedScanAction,
): ActionPreflightReadPlan | null {
  const now = ctx.clock.now();
  const prepared = prepareActionPassFence(
    ctx.env.DB,
    found.pass,
    found.checkInRules,
    found.connectionGeneration,
    found.activeVersion,
    found.orgRevision,
    found.templateRevision,
    now,
    ctx.env,
    found,
  );
  if (!prepared) return null;
  const eventId =
    actor.event?.id ?? found.checkInRules?.eventId ?? actor.settings.checkIn?.eventId ?? null;
  const admissionScope = eventId ? `event:${eventId}` : '';
  const configured =
    Object.keys(found.checkInRules ?? {}).length > 0 ||
    Object.keys(actor.settings.checkIn ?? {}).length > 0 ||
    actor.settings.direction === 'out' ||
    actor.settings.direction === 'both';
  const scoped =
    action.repeat === 'once' && eventId ? admissionScope : gateScope(action, actor, now);
  const gate = {
    passId: found.pass.id,
    actionId: action.id,
    scope:
      configured && (found.checkInRules?.mode || actor.settings.checkIn?.mode)
        ? admissionScope
        : scoped,
  };
  const presenceScope = configured || actor.event ? admissionScope : gate.scope;
  const heldReads = heldGateReads(ctx.env.DB, actor, gate, eventId);
  let current: ActionPreflight | null = null;
  return {
    stmts: [
      prepared.statement,
      snapshots.readScanEffectStmt(ctx.env.DB, gate, presenceScope),
      ...heldReads.stmts,
    ],
    async finish(results) {
      if (
        results.length !== 2 + heldReads.stmts.length ||
        !results.every((result): result is D1Result => result.success !== false)
      )
        return;
      const held = heldReads.finish(results.slice(2));
      const passFence = await prepared.complete(
        results[0]?.results?.[0] as { rules: string | null } | undefined,
      );
      if (passFence && held)
        current = {
          gate,
          presenceScope,
          prepared,
          passFence,
          observed: snapshots.scanEffectFromResult(results[1]),
          held,
        };
    },
    current: () => current,
  };
}
