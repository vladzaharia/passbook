import type { ScanActor } from './guard.ts';
import { heldGateCapacityStmt, heldGateHolderStmt } from './repo-act-gate-preflight.ts';
import type { GateKey, GateRule } from './repo-gates.ts';
import type { ScanGateSnapshot } from './repo-scan-effect.ts';

export interface HeldGateSnapshot {
  holder: D1Result;
  capacityFull: boolean | null;
}

export interface HeldGateReadPlan {
  stmts: D1PreparedStatement[];
  finish(results: readonly (D1Result | { success: false })[]): HeldGateSnapshot | null;
}

/** Capture holder and capacity alongside the caller's post-evaluation PIN reservation. */
export function heldGateReads(
  db: D1Database,
  actor: ScanActor,
  gate: GateKey,
  eventId: string | null,
): HeldGateReadPlan {
  const holder = heldGateHolderStmt(db, gate);
  const capacity = eventId ? heldGateCapacityStmt(db, actor, gate, eventId) : null;
  const stmts = [holder, ...(capacity ? [capacity] : [])];
  return {
    stmts,
    finish(results) {
      if (
        results.length !== stmts.length ||
        !results[0] ||
        !results.every((result): result is D1Result => result.success !== false)
      )
        return null;
      const capacityRow = results[1]?.results?.[0];
      if (
        capacityRow !== undefined &&
        (!capacityRow ||
          typeof capacityRow !== 'object' ||
          !('full' in capacityRow) ||
          (capacityRow.full !== 0 && capacityRow.full !== 1))
      )
        return null;
      const full =
        capacityRow && typeof capacityRow === 'object' && 'full' in capacityRow
          ? capacityRow.full
          : undefined;
      return { holder: results[0], capacityFull: full === undefined ? null : full === 1 };
    },
  };
}

/** A captured gate is certainly held only if its original rule still blocks its UPSERT. */
export function gateWasHeld(gate: ScanGateSnapshot | null, rule: GateRule, now: number): boolean {
  if (!gate || rule.rule === 'always') return false;
  if (rule.rule === 'once') return gate.state !== 'undone';
  return gate.lastAt > now - rule.cooldownMs;
}
