import type { CheckInState } from '../../../shared/contracts/check-in.ts';
import type { ScanAccess } from '../../../shared/contracts/scan.ts';
import type { ScanAdmit } from '../../../shared/contracts/scan-admit.ts';
import { cardPrivacy } from './dto-projection.ts';
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
  safe: (label: string) => boolean,
  state: CheckInState | undefined = found.admission?.state,
): ScanAdmit {
  const event = found.admission?.event ?? actor.event;
  const until = access?.closesAt ?? state?.validUntil ?? null;
  const repeat = found.scan.actions.find((a) => a.kind === 'check_in')?.repeat;
  const mode = state?.mode ?? (repeat === 'once' ? 'single' : repeat === 'daily' ? 'daily' : null);
  const visits = access?.visits;
  const rule: ScanAdmit['rule'] =
    event && safe(event.name)
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

/**
 * The outcome's access and admit after the same label privacy as the template: a plan label that
 * fails falls back to the redacted template name, and a hidden template drops admit.
 */
export function safeAdmitAccess(
  found: Found | null,
  actor: ScanActor,
  access: ScanAccess | null | undefined,
  template: { name: string } | null,
  state?: CheckInState,
): { access: ScanAccess | null; admit?: ScanAdmit } {
  if (!found) return { access: access ?? null };
  let safe = (_: string) => false;
  try {
    const privacy = cardPrivacy(found, actor);
    safe = (label) => privacy.safe(label);
  } catch {
    // Nothing is private-safe when the policy cannot be read.
  }
  const shown =
    access && !safe(access.plan.label)
      ? { ...access, plan: { ...access.plan, label: template?.name ?? 'Plan' } }
      : (access ?? null);
  return {
    access: shown,
    ...(template ? { admit: admitOf(found, actor, shown, template.name, safe, state) } : {}),
  };
}
