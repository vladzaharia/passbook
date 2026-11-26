/** What an outcome says about access and occupancy: its lines, values, beat and dock verbs. Pure. */
import {
  SCAN_COPY,
  SCAN_OCCUPANCY_COPY,
  type ScanLine,
  scanLine,
} from '../../../shared/copy/scan.ts';
import { formatStay, formatTime, formatWeekdayTime } from '../../lib/format.ts';
import { sessionTime } from '../ui/session-time.ts';
import { accessBeat, type ResolvedOutcome } from './access-events.ts';
import type { BuddyBeat, ScanOutcome } from './types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 1 h 32 min, 12 min, 40 s, 7 d 15 h. */
export const stayText = formatStay;

/** 40 s ago, 12 min ago, 3 h ago, 14 d ago: the unit a person would say. */
export function agoText(ms: number): string {
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

export const isExit = (o: ScanOutcome): boolean =>
  o.kind === 'ok' &&
  (o.occupancy ? o.occupancy.direction === 'out' : o.checkIn?.direction === 'out');

/** An Access card's grant: the band says Access granted. */
export const isGrant = (o: ScanOutcome): boolean =>
  o.kind === 'ok' && o.access !== null && !isExit(o) && o.action?.id !== 'undo';

const isZone = (o: ScanOutcome): boolean => o.occupancy?.place.kind === 'zone';

/** Fills for `{plan}`, `{zone}`, `{when}`, `{limit}`, `{time}`, `{stay}`, `{in}`, `{capacity}`, `{ago}`, `{scanner}`, `{staff}`. Only values that exist. */
export function accessValues(o: ScanOutcome, now: number): Record<string, string | number> {
  const v: Record<string, string | number> = {};
  const a = o.access;
  const p = o.occupancy;
  const zone = a?.zone?.name ?? p?.place.name;
  if (zone) v.zone = zone;
  if (a) {
    v.plan = a.plan.label;
    if (a.nextOpenAt) v.when = formatWeekdayTime(a.nextOpenAt, a.timeZone);
    if (a.visits?.limit != null) v.limit = a.visits.limit;
    if (a.closesAt) v.time = formatTime(a.closesAt, a.timeZone);
  }
  if (p) {
    if (p.stayMs != null) v.stay = stayText(p.stayMs);
    if (p.inNow != null) v.in = p.inNow;
    if (p.capacity != null) v.capacity = p.capacity;
    if (p.since != null) {
      v.ago = agoText(Math.max(0, now - p.since));
      if (!v.time || o.kind === 'heads_up') v.time = sessionTime(p.since);
    }
    if (p.via) v.scanner = p.via;
  }
  const by = (o as ResolvedOutcome).resolvedBy;
  if (by) v.staff = by;
  return v;
}

/** A sub made of parts: the parts whose values are missing drop out ("{zone} · until {time}"). */
function joined(template: string, values: Record<string, string | number>): string {
  return template
    .split(' · ')
    .map((part) => scanLine(part, values))
    .filter((part) => !/\{\w+\}/.test(part))
    .join(' · ');
}

/** `until {time}` only when access closes within 12 hours. */
function grantValues(o: ScanOutcome, now: number): Record<string, string | number> {
  const v = accessValues(o, now);
  const closes = o.access?.closesAt;
  if (!closes || closes - now > 12 * HOUR) delete v.time;
  return v;
}

export interface OutcomeLines {
  title: string;
  sub: string;
}

/** The headline and sub of an outcome that access or occupancy words. Null leaves the default. */
export function accessLines(o: ScanOutcome, now: number): OutcomeLines | null {
  const copy = SCAN_COPY.verdict;
  if (o.kind === 'ok') {
    const by = (o as ResolvedOutcome).resolvedBy;
    if (isExit(o) && isZone(o)) {
      const v = accessValues(o, now);
      return { title: copy.tappedOut, sub: joined(copy.tappedOutSub, v) };
    }
    if (by && o.access) {
      const v = accessValues(o, now);
      return { title: copy.access.headline, sub: joined(copy.letInBy, v) };
    }
    if (isGrant(o)) {
      return { title: copy.access.headline, sub: joined(copy.access.sub, grantValues(o, now)) };
    }
    return null;
  }
  if (o.kind !== 'heads_up' || !o.occupancy) return null;
  const v = accessValues(o, now);
  const p = o.occupancy;
  let line: ScanLine | null = null;
  if (o.reason === 'capacity_full' && isZone(o)) line = SCAN_OCCUPANCY_COPY.zoneFull ?? null;
  else if (o.reason === 'still_inside')
    line =
      p.place.kind === 'event'
        ? (SCAN_OCCUPANCY_COPY.eventStillIn ?? null)
        : p.since !== null && now - p.since < HOUR
          ? (SCAN_OCCUPANCY_COPY.stillInRecent ?? null)
          : null;
  else if (o.reason === 'not_inside')
    line =
      p.turnaround === 'in'
        ? (SCAN_OCCUPANCY_COPY.alreadyOut ?? null)
        : p.place.kind === 'event'
          ? (SCAN_OCCUPANCY_COPY.eventNotIn ?? null)
          : null;
  return line ? { title: scanLine(line.headline, v), sub: scanLine(line.sub, v) } : null;
}

export const announceOf = (o: ScanOutcome, now: number): string => {
  const lines = accessLines(o, now);
  const who = o.card?.title ?? o.display?.identity.holder ?? null;
  const head = lines?.title ?? o.action?.label ?? 'Done';
  return who ? `${head}. ${who}` : head;
};

/** The pill that leads the sub: what this scan did. */
export function directionPill(o: ScanOutcome): 'in' | 'out' | null {
  if (o.kind !== 'ok' || !o.occupancy || o.action?.id === 'undo') return null;
  return o.occupancy.direction;
}

/** The buddy beat of an ok outcome that access or occupancy decided. */
export function accessBeatOf(o: ScanOutcome): BuddyBeat | null {
  if (o.kind !== 'ok') return null;
  if ((o as ResolvedOutcome).resolvedBy) return accessBeat('relent');
  if (isExit(o)) return accessBeat('bye');
  if (isGrant(o)) return accessBeat('gate');
  return null;
}

/** Holds a person is let in again after: a repeat. Every other hold is a first entry, `anyway`. */
const REPEAT = new Set<string>(['already_done', 'still_inside']);

export type HoldVerb =
  | { kind: 'turn'; direction: 'in' | 'out'; label: string }
  | { kind: 'letIn'; label: string };

/** The dock verbs of a hold, before Done. A turnaround hold offers Tap in or Tap out. */
export function holdVerbs(o: ScanOutcome): HoldVerb[] {
  // OC4: a voided or ended pass that is inside can only leave.
  if (o.kind === 'refused' && o.exitAllowed)
    return [{ kind: 'turn', direction: 'out', label: SCAN_COPY.actions.checkOut }];
  if (o.kind !== 'heads_up') return [];
  const t = o.occupancy?.turnaround;
  if (t) {
    const direction = t === 'out' ? 'out' : 'in';
    return [
      {
        kind: 'turn',
        direction,
        label: direction === 'out' ? SCAN_COPY.actions.tapOut : SCAN_COPY.actions.tapIn,
      },
    ];
  }
  // A manager's PIN is the way past needs_approval, never a bare override.
  if (o.overridable && o.action && o.reason !== 'needs_approval')
    return [
      {
        kind: 'letIn',
        label:
          o.reason && REPEAT.has(o.reason)
            ? SCAN_COPY.actions.letInAgain
            : SCAN_COPY.actions.letInAnyway,
      },
    ];
  return [];
}
