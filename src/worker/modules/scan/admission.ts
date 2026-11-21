import type { CheckInPolicy, CheckInState } from '../../../shared/contracts/check-in.ts';
import type { ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { localDayStart } from './counts.ts';
import type { ScanActor } from './guard.ts';
import { type FoundOccupancy, planEventOccupancy } from './occupancy/admission.ts';
import { admissionReads } from './repo-admission.ts';
import { presenceSnapshot } from './repo-scan-effect.ts';
import type { Found } from './resolve.ts';

const HOUR = 3_600_000;

/** The local midnight that ends a pass of `days` days counted from `anchor`'s day (1 = tonight). */
export function dayLimitEnd(anchor: number, days: number, timeZone: string): number {
  let end = localDayStart(anchor, timeZone);
  // 36 h past a local midnight is inside the next day, whatever a DST change does to the day's length.
  for (let i = 0; i < days; i++) end = localDayStart(end + 36 * HOUR, timeZone);
  return end;
}

/** The pass type's own duration and day limits; a pass's rules override them, the scanner's cap tightens them. */
export function templateRules(found: Pick<Found, 'scan'>): CheckInPolicy {
  const c = found.scan.checkIn;
  return {
    ...(c?.days === undefined ? {} : { days: c.days }),
    ...(c?.durationMinutes === undefined ? {} : { durationMinutes: c.durationMinutes }),
    ...(c?.durationFrom === undefined ? {} : { durationFrom: c.durationFrom }),
  };
}

/** The rules of the pass: its type's defaults under its own. */
export const passRulesOf = (found: Pick<Found, 'scan' | 'checkInRules'>): CheckInPolicy => ({
  ...templateRules(found),
  // A null clears nothing: a pass cannot erase its type's limit.
  ...Object.fromEntries(Object.entries(found.checkInRules ?? {}).filter(([, v]) => v !== null)),
});

export function completedAdmission(plan: AdmissionPlan, now: number): CheckInState {
  const firstAt = plan.state.firstAt ?? now;
  const until = plan.state.validUntil === null ? [] : [plan.state.validUntil];
  for (const rule of plan.rules) {
    if (rule.durationMinutes != null && rule.durationFrom !== 'issued')
      until.push(firstAt + rule.durationMinutes * 60_000);
    if (rule.days != null && rule.durationFrom !== 'issued')
      until.push(dayLimitEnd(firstAt, rule.days, plan.zone));
  }
  return {
    ...plan.state,
    firstAt,
    inside: plan.tracked && plan.state.direction === 'in',
    enteredAt: plan.tracked && plan.state.direction === 'in' ? now : null,
    validUntil: until.length ? Math.min(...until) : null,
  };
}

export function policyAction(action: ResolvedScanAction, rules: CheckInPolicy): ResolvedScanAction {
  if (action.kind !== 'check_in' || !rules.mode) return action;
  return {
    ...action,
    repeat: rules.mode === 'single' ? 'once' : rules.mode === 'daily' ? 'daily' : 'always',
    allowAgain: rules.mode === 'single' || rules.mode === 'daily' ? false : action.allowAgain,
  };
}

export async function planAdmission(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  requested?: 'in' | 'out',
  extraReads?: {
    stmts: D1PreparedStatement[];
    finish(results: readonly D1Result[]): Promise<void>;
  },
): Promise<{
  plan: AdmissionPlan;
  reason: ScanReason | null;
  at: number | null;
  flags: string[];
  /** A re-entry event is a place: the builder decides in and out, so the place reasons are skipped. */
  place: { found: FoundOccupancy; turnaround: 'in' | 'out' | null } | null;
}> {
  const passRule = passRulesOf(found);
  const scannerRule = actor.settings.checkIn ?? {};
  const rules = [passRule, scannerRule];
  const action = found.scan.actions.find((a) => a.kind === 'check_in');
  const baseMode =
    action?.repeat === 'once' ? 'single' : action?.repeat === 'daily' ? 'daily' : 'unlimited';
  const modes = [passRule.mode ?? baseMode, ...(scannerRule.mode ? [scannerRule.mode] : [])];
  const mode = modes.includes('single')
    ? 'single'
    : modes.includes('in_out')
      ? 'in_out'
      : modes.includes('daily')
        ? 'daily'
        : modes.includes('unlimited')
          ? 'unlimited'
          : action?.repeat === 'once'
            ? 'single'
            : action?.repeat === 'daily'
              ? 'daily'
              : 'unlimited';
  const eventIds = [actor.event?.id, ...rules.map((p) => p.eventId)].filter(
    (id): id is string => !!id,
  );
  const eventId = eventIds[0] ?? null;
  const knownEvent = actor.event?.id === eventId ? actor.event : null;
  const now = ctx.clock.now();
  const {
    history: rawHistory,
    presence,
    event,
    additional,
  } = await admissionReads(
    ctx.env.DB,
    actor.orgId,
    found.pass.id,
    eventId,
    knownEvent,
    extraReads?.stmts,
  );
  const day = localDayStart(now, event?.timeZone ?? actor.timeZone);
  const scope = event ? `event:${event.id}` : '';
  const history = rawHistory && {
    ...rawHistory,
    today_at: rawHistory.last_at !== null && rawHistory.last_at >= day ? rawHistory.last_at : null,
  };
  if (extraReads) await extraReads.finish(additional);
  const setupDirection = actor.settings.direction ?? (mode === 'in_out' ? 'both' : 'in');
  const place =
    event?.reentry &&
    event.archivedAt === null &&
    event.mode === actor.mode &&
    actor.event?.id === event.id
      ? planEventOccupancy({
          event,
          row: presence && {
            ...presence,
            due_at: null,
            changed_at: presence.changed_at ?? null,
            via: presence.via ?? null,
          },
          setting: setupDirection,
          requested,
          now,
        })
      : null;
  const tracked = !!place || mode === 'in_out';
  const inside = place ? place.found.inside : presence?.tracking === 1 && presence.state === 'in';
  const direction = place
    ? place.found.direction
    : setupDirection === 'both'
      ? (requested ?? (tracked && inside ? 'out' : 'in'))
      : setupDirection;
  const from = rules.flatMap((p) => (p.validFrom == null ? [] : [p.validFrom]));
  const until = rules.flatMap((p) => (p.validUntil == null ? [] : [p.validUntil]));
  if (event && rules.some((p) => p.eventId)) {
    from.push(event.opensAt);
    until.push(event.closesAt);
  }
  for (const rule of rules)
    if (rule.durationMinutes != null) {
      const anchor =
        rule.durationFrom === 'issued'
          ? found.pass.createdAt
          : (presence?.first_at ?? history?.first_at);
      if (anchor != null) until.push(anchor + rule.durationMinutes * 60_000);
    }
  const zone = event?.timeZone ?? actor.timeZone;
  for (const rule of rules)
    if (rule.days != null) {
      const anchor =
        rule.durationFrom === 'issued'
          ? found.pass.createdAt
          : (presence?.first_at ?? history?.first_at);
      if (anchor != null) until.push(dayLimitEnd(anchor, rule.days, zone));
    }
  const validFrom = from.length ? Math.max(...from) : null;
  const validUntil = until.length ? Math.min(...until) : null;
  const limited =
    rules.some((p) => p.mode !== undefined) &&
    (modes.includes('single') || modes.includes('daily'));
  const plan: AdmissionPlan = {
    scope,
    zone,
    event,
    tracked,
    rules,
    previousScanId: presence?.last_scan_id ?? null,
    presence: presenceSnapshot(presence),
    limited,
    limitSince: modes.includes('single') ? null : day,
    state: {
      mode,
      direction,
      inside,
      enteredAt: inside ? (presence?.entered_at ?? null) : null,
      firstAt: presence?.first_at ?? history?.first_at ?? null,
      validFrom,
      validUntil,
    },
  };
  let reason: ScanReason | null = null;
  let at: number | null = null;
  const flags: string[] = [];
  if (
    eventIds.some((id) => id !== eventId) ||
    (eventId && (!event || event.mode !== actor.mode || event.archivedAt !== null))
  )
    reason = 'wrong_event';
  else if (direction === 'out' && !tracked) {
    reason = 'not_accepted';
    flags.push('This pass does not allow check-out.');
  } else if (!place && tracked && direction === 'out' && !inside) reason = 'not_inside';
  else if (!place && tracked && direction === 'in' && inside) {
    reason = 'still_inside';
    at = presence?.entered_at ?? null;
  } else if (
    !place &&
    tracked &&
    direction === 'in' &&
    presence?.tracking === 1 &&
    presence.state === 'out' &&
    event?.reentry === false
  )
    reason = 'already_done';
  else if (direction !== 'out' && validFrom !== null && now < validFrom) {
    reason = 'not_yet_valid';
    at = validFrom;
  } else if (direction !== 'out' && validUntil !== null && now >= validUntil) {
    reason = 'ended';
    at = validUntil;
  } else if (
    limited &&
    direction === 'in' &&
    (modes.includes('single')
      ? presence !== null || history?.last_at != null
      : (presence?.last_entry_at ?? -1) >= day || history?.today_at != null)
  ) {
    reason = 'already_done';
    at = presence?.last_entry_at ?? history?.last_at ?? null;
  }
  return { plan, reason, at, flags, place };
}
