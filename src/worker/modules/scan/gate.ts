import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { localDay } from './counts.ts';
import type { ScanActor } from './guard.ts';
import type { GateRule } from './repo-gates.ts';

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
