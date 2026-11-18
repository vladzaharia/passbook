import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { localDay } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { ACCESS_GATE } from './repo-access.ts';
import type { GateKey, GateRule } from './repo-gates.ts';
import type { Found } from './resolve.ts';

const MINUTE = 60_000;

/** The scope a gate row is keyed on: the event, else the venue day for `daily`, else none (SA 7.3). */
export function gateScope(action: ResolvedScanAction, actor: ScanActor, now: number): string {
  if (action.repeat === 'daily') return `day:${localDay(now, actor.timeZone)}`;
  if (action.repeat === 'once' && actor.event) return `event:${actor.event.id}`;
  return '';
}

export function gateRule(action: ResolvedScanAction): GateRule {
  if (action.repeat === 'cooldown')
    return { rule: 'cooldown', cooldownMs: (action.cooldownMinutes ?? 5) * MINUTE };
  return action.repeat === 'always' ? { rule: 'always' } : { rule: 'once' };
}

/**
 * An Access card's check-in at a door counts visits on its own gate row, whatever the action is
 * called (AX 3.5). Known before the zones are read: the preflight needs the key first.
 */
export function accessGateOf(
  found: Found,
  actor: ScanActor,
  action: ResolvedScanAction,
): GateKey | null {
  return found.activePolicy.manifest.scan?.access && !actor.event && action.kind === 'check_in'
    ? { passId: found.pass.id, actionId: ACCESS_GATE, scope: ACCESS_GATE }
    : null;
}

/** The same key once the decision is made: an event the pass's own policy named does not change it. */
export const settledAccessGate = (found: Found, action: ResolvedScanAction): GateKey | null =>
  found.access && action.kind === 'check_in'
    ? { passId: found.pass.id, actionId: ACCESS_GATE, scope: ACCESS_GATE }
    : null;
