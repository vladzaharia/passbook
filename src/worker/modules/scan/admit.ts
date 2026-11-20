import type { CheckInState } from '../../../shared/contracts/check-in.ts';
import type { ScanAccess } from '../../../shared/contracts/scan.ts';
import type { ScanAdmit } from '../../../shared/contracts/scan-admit.ts';
import type { ScanActor } from './guard.ts';
import type { Found } from './resolve.ts';

/**
 * The verdict's pass type and rule (design-multi-pass-entry §2). The type is the plan label, else
 * the template name, as the outcome's redacted `template` shows it. The rule is the first that applies: the event, a visit count, the end of the
 * pass or the day, then the repeat mode. A type with none of these has no rule to show.
 */
export function admitOf(
  found: Found,
  actor: ScanActor,
  access: ScanAccess | null | undefined,
  name: string,
  state: CheckInState | undefined = found.admission?.state,
): ScanAdmit {
  const event = found.admission?.event;
  const until = access?.closesAt ?? state?.validUntil ?? null;
  const repeat = found.scan.actions.find((a) => a.kind === 'check_in')?.repeat;
  const mode = state?.mode ?? (repeat === 'once' ? 'single' : repeat === 'daily' ? 'daily' : null);
  const visits = access?.visits;
  const rule: ScanAdmit['rule'] = event
    ? { kind: 'event', name: event.name }
    : visits && visits.limit !== null
      ? access.visit
        ? { kind: 'visit', n: visits.used, of: visits.limit }
        : { kind: 'left', n: Math.max(0, visits.limit - visits.used) }
      : until !== null
        ? { kind: 'until', at: until }
        : mode === 'single'
          ? { kind: 'once' }
          : mode === 'daily'
            ? { kind: 'daily' }
            : null;
  return {
    type: access?.plan.label ?? name,
    rule,
    timeZone: access?.timeZone ?? event?.timeZone ?? actor.timeZone,
  };
}
