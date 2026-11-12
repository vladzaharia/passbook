import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ScanActor } from './guard.ts';
import type { Found, Stop } from './resolve.ts';
import { ROLE_RANK } from './rules.ts';

/** What an override of an earlier heads-up waives; every other step still runs. */
export interface Waive {
  window?: boolean;
  confirmed?: boolean;
  direction?: 'in' | 'out';
}

/** Retain pinned action semantics while applying the stricter current authority policy. */
export function currentActions(
  pinned: ResolvedScanAction[],
  active: ResolvedScanAction[],
): ResolvedScanAction[] {
  return pinned.flatMap((action) => {
    const policy = active.find((item) => item.id === action.id && item.kind === action.kind);
    if (!policy) return [];
    return [
      {
        ...action,
        minRole:
          ROLE_RANK[policy.minRole] > ROLE_RANK[action.minRole] ? policy.minRole : action.minRole,
        allowAgain: action.allowAgain && policy.allowAgain,
      },
    ];
  });
}

export const stop = (
  kind: Stop['kind'],
  reason: ScanReason,
  more: Partial<Omit<Stop, 'stop' | 'kind' | 'reason'>> = {},
): Stop => ({
  stop: true,
  kind,
  reason,
  pass: null,
  ref: null,
  at: null,
  flags: [],
  found: null,
  ...more,
});

const MINUTE = 60_000;
const instant = (value: unknown): number | null => {
  const t = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

export function windowStop(actor: ScanActor, found: Found, now: number, waive: Waive): Stop | null {
  const withFound = {
    pass: found.pass,
    ref: found.ref,
    found,
    connectionGeneration: found.connectionGeneration,
  };
  const w = found.scan.window;
  if (w && !waive.window) {
    const from = w.from ? instant(found.pass.personalization[w.from]) : null;
    const until = w.until ? instant(found.pass.personalization[w.until]) : null;
    const opens =
      found.checkInRules?.validFrom !== undefined
        ? found.checkInRules.validFrom
        : from === null
          ? null
          : from - (w.earlyMinutes ?? 0) * MINUTE;
    const closes =
      found.checkInRules?.validUntil !== undefined
        ? found.checkInRules.validUntil
        : until === null
          ? null
          : until + (w.lateMinutes ?? 0) * MINUTE;
    if (opens !== null && now < opens)
      return stop('heads_up', 'not_yet_valid', { ...withFound, at: opens });
    if (closes !== null && now > closes)
      return stop('heads_up', 'ended', { ...withFound, at: closes });
  }
  const event = actor.event;
  if (event && !waive.window) {
    if (now < event.opensAt)
      return stop('heads_up', 'not_yet_valid', { ...withFound, at: event.opensAt });
    if (now > event.closesAt)
      return stop('heads_up', 'ended', { ...withFound, at: event.closesAt });
  }
  return null;
}
