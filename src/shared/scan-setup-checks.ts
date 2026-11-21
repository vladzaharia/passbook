import type { Mode } from './contracts/common.ts';
import type { ScanRole } from './contracts/scan.ts';
import type { WeeklyHours } from './contracts/scan-access.ts';
import type { ScanSetupCheck } from './contracts/scan-setup-intent.ts';
import type { SessionHours } from './contracts/scanning-sessions.ts';

/**
 * One door (a session) as the checks see it. A plan maps into this (`planCheckFacts`), and so does a
 * live session: its devices, its zone, its events and the org's staff. Refs are ids on a live session.
 */
export interface DoorFacts {
  ref: string;
  name: string;
  /** Admits events and no pass type. */
  eventOnly: boolean;
  place: {
    ref: string;
    name: string;
    /** The zone's key, then its ancestors' keys. Empty when the place is not a zone. */
    keys: string[];
    counted: boolean;
    /** People scan out (false: max stay and clear-at empty it). */
    exits: boolean;
    max: number | null;
  } | null;
  events: { ref: string; name: string; reentry: boolean; max: number | null; issued: number }[];
  /** Admitted pass types. `plans` is null on a template that is not an Access card. */
  templates: {
    id: string;
    name: string;
    plans: { id: string; label: string; zones: string[]; hours: WeeklyHours | null }[] | null;
  }[];
  hours: SessionHours | null;
  /** The session's direction; null is by pass rules. */
  direction: 'in' | 'out' | 'both' | null;
  /** The check-in type is Track in / out. */
  tracks: boolean;
  staffSignIn: boolean;
  /** The offline list is chosen but the settings or zone rule it out: `settingsOfflineVerdict`'s message. */
  offlineBlocked?: string | null;
  devices: {
    ref: string;
    name: string;
    role: 'scan' | 'customer' | 'monitor';
    /** Null: by pass rules, which may scan out. */
    direction: 'in' | 'out' | 'both' | null;
    reader: 'none' | 'barcode' | 'nfc';
    revoked?: boolean;
  }[];
}
export interface SetupCheckFacts {
  mode: Mode;
  /** The org's staff after setup. */
  staff: { role: ScanRole; active: boolean }[];
  doors: DoorFacts[];
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** A span as same-day ranges: one running past midnight splits in two. */
function ranges(span: string): [number, number][] {
  const start = minutes(span);
  const end = minutes(span.slice(6));
  if (end > start) return [[start, end]];
  return end > 0
    ? [
        [start, 1440],
        [0, end],
      ]
    : [[start, 1440]];
}
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const rb = b.flatMap(ranges);
  return a.flatMap(ranges).some(([s, e]) => rb.some(([s2, e2]) => s < e2 && s2 < e));
}

function doorChecks(door: DoorFacts, staff: SetupCheckFacts['staff']): ScanSetupCheck[] {
  const out: ScanSetupCheck[] = [];
  const at = { door: door.ref };
  const devices = door.devices.filter((d) => !d.revoked && d.role !== 'monitor');
  const reentry = door.events.find((e) => e.reentry);
  const counted = door.place?.counted === true && door.place.exits;
  if ((counted || reentry) && !devices.some((d) => d.direction !== 'in')) {
    const turn = devices.find((d) => d.reader !== 'barcode');
    out.push({
      code: 'NO_EXIT',
      level: 'warn',
      message: 'noExit',
      params: { place: counted && door.place ? door.place.name : (reentry?.name ?? door.name) },
      ...at,
      fix: turn
        ? { kind: 'device_direction', device: turn.ref, direction: 'both' }
        : { kind: 'add_device', session: door.ref, direction: 'out' },
    });
  }
  const directed = door.direction !== null || devices.some((d) => d.direction !== null);
  if ((directed || reentry) && !door.tracks)
    out.push({
      code: 'DIRECTION_NEEDS_TRACKING',
      level: 'error',
      message: 'directionNeedsTracking',
      params: { door: door.name },
      ...at,
      fix: { kind: 'track_in_out', session: door.ref },
    });
  if (door.offlineBlocked)
    out.push({
      code: 'OFFLINE_LIST_BLOCKED',
      level: 'error',
      message: 'offlineListBlocked',
      params: { door: door.name, reason: door.offlineBlocked },
      ...at,
    });
  const active = staff.filter((s) => s.active);
  const max = door.place?.max != null || door.events.some((e) => e.max !== null);
  if (door.staffSignIn && active.length === 0)
    out.push({
      code: 'NO_STAFF',
      level: 'error',
      message: 'noStaff',
      params: { door: door.name },
      ...at,
      fix: { kind: 'add_staff', role: 'manager' },
    });
  else if (door.staffSignIn && max && !active.some((s) => s.role === 'manager'))
    out.push({
      code: 'NO_MANAGER',
      level: 'warn',
      message: 'noManager',
      params: { place: door.place?.name ?? door.events.find((e) => e.max !== null)?.name ?? '' },
      ...at,
      fix: { kind: 'add_staff', role: 'manager' },
    });
  if (door.eventOnly && door.place)
    out.push({
      code: 'PLACE_ON_EVENT',
      level: 'error',
      message: 'placeOnEvent',
      params: { door: door.name },
      ...at,
      subject: { kind: 'zone', ref: door.place.ref },
      fix: { kind: 'remove_place', session: door.ref },
    });
  for (const d of devices)
    if (d.reader === 'barcode' && d.direction === 'both')
      out.push({
        code: 'READER_BOTH',
        level: 'error',
        message: 'readerBoth',
        params: { device: d.name },
        ...at,
        subject: { kind: 'device', ref: d.ref },
        fix: { kind: 'device_direction', device: d.ref, direction: 'in' },
      });
  for (const t of door.templates) {
    if (t.plans === null) continue;
    const place = door.place;
    if (place && place.keys.length > 0 && !door.eventOnly) {
      const grants = t.plans.some((p) => p.zones.some((z) => z === '*' || place.keys.includes(z)));
      if (!grants)
        out.push({
          code: 'PLAN_MISSES_PLACE',
          level: 'warn',
          message: 'planMissesPlace',
          params: { template: t.name, place: place.name },
          ...at,
          subject: { kind: 'template', ref: t.id },
          fix: { kind: 'open_template', templateId: t.id },
        });
    }
    const hours = door.hours;
    if (!hours) continue;
    for (const p of t.plans) {
      const day = DAYS.find((d) => {
        const own = hours[d];
        const plan = p.hours?.[d];
        return own && plan && !overlaps(own, plan);
      });
      if (day)
        out.push({
          code: 'HOURS_DIFFER',
          level: 'info',
          message: 'hoursDiffer',
          params: { template: t.name, plan: p.label, door: door.name, day },
          ...at,
          subject: { kind: 'template', ref: t.id },
        });
    }
  }
  return out;
}

/** Every check, in door order; shared events are reported once. Any `error` stops apply. */
export function setupChecks(facts: SetupCheckFacts): ScanSetupCheck[] {
  const out = facts.doors.flatMap((d) => doorChecks(d, facts.staff));
  const seen = new Set<string>();
  for (const door of facts.doors)
    for (const e of door.events) {
      if (e.issued > 0 || seen.has(e.ref)) continue;
      seen.add(e.ref);
      out.push({
        code: 'EVENT_NO_PASSES',
        level: 'info',
        message: 'eventNoPasses',
        params: { event: e.name },
        door: door.ref,
        subject: { kind: 'event', ref: e.ref },
      });
    }
  if (facts.mode === 'test') out.push({ code: 'TEST_ONLY', level: 'info', message: 'testOnly' });
  return out;
}

export const hasErrors = (checks: readonly ScanSetupCheck[]): boolean =>
  checks.some((c) => c.level === 'error');
