import {
  closesAt,
  dateKey,
  isOpen,
  nextFlip,
  nextOpen,
  wall,
} from '../../../passkit/template/access/hours.ts';
import {
  type SessionHold,
  SessionHoldSchema,
  type SessionHours,
  SessionHoursSchema,
  type SessionWindow,
} from '../../../shared/contracts/scanning-sessions.ts';

import { ForbiddenError } from '../../platform/errors.ts';

const HOUR = 3_600_000;
export const HOLD_MAX_MS = 24 * HOUR;
const DEFAULT_OPEN_MS = 2 * HOUR;
const EARLY_START_MS = 6 * HOUR;
const HORIZON_MS = 8 * 24 * HOUR;

/** The columns the evaluator reads. */
export interface HoursFields {
  time_zone: string;
  hours?: string | null | undefined;
  hold?: string | null | undefined;
}

function parse<T>(
  raw: string | null | undefined,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): T | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Null: always open. A stored schedule that no longer parses is `invalid` and closes the session. */
export const storedHours = (raw: string | null | undefined): SessionHours | null | 'invalid' =>
  parse(raw, SessionHoursSchema);

/** Drops exceptions dated before today in the session's zone; they can no longer matter. */
export function pruneDates(hours: SessionHours, timeZone: string, now: number): SessionHours {
  if (!hours.dates) return hours;
  const w = wall(now, timeZone);
  const today = dateKey(w.y, w.m, w.d);
  const kept = Object.entries(hours.dates).filter(([key]) => key >= today);
  const { dates: _old, ...rest } = hours;
  return kept.length > 0 ? { ...rest, dates: Object.fromEntries(kept) } : rest;
}

/** The hold in force at `now`; one past its end is as good as none. */
export function activeHold(raw: string | null | undefined, now: number): SessionHold | null {
  const hold = parse(raw, SessionHoldSchema);
  return hold && hold !== 'invalid' && now < hold.until ? hold : null;
}

/** Open at an instant by hold, then hours. `status` is the caller's: this ignores it. */
export function openAt(row: HoursFields, t: number): boolean {
  const hold = activeHold(row.hold, t);
  if (hold) return hold.state === 'open';
  const hours = storedHours(row.hours);
  if (hours === null) return true;
  return hours !== 'invalid' && isOpen(hours, row.time_zone, t);
}

export function sessionWindow(row: HoursFields, now: number): SessionWindow {
  const hold = activeHold(row.hold, now);
  if (hold) {
    const open = hold.state === 'open';
    return {
      open,
      by: 'hold',
      opensAt: open ? null : hold.until,
      closesAt: open ? hold.until : null,
    };
  }
  const hours = storedHours(row.hours);
  if (hours === null) return { open: true, by: 'always', opensAt: null, closesAt: null };
  if (hours === 'invalid') return { open: false, by: 'hours', opensAt: null, closesAt: null };
  if (isOpen(hours, row.time_zone, now))
    return {
      open: true,
      by: 'hours',
      opensAt: null,
      closesAt: closesAt([hours], row.time_zone, now),
    };
  return {
    open: false,
    by: 'hours',
    opensAt: nextOpen([hours], row.time_zone, now),
    closesAt: null,
  };
}

/** When the schedule next opens after it next closes (or now, when closed); null within 8 days: none. */
export function nextScheduledOpen(row: HoursFields, now: number): number | null {
  const hours = storedHours(row.hours);
  if (hours === null || hours === 'invalid') return null;
  const from = isOpen(hours, row.time_zone, now) ? closesAt([hours], row.time_zone, now) : now;
  if (from === null) return null;
  const at = nextOpen([hours], row.time_zone, from);
  return at !== null && at - now <= HORIZON_MS ? at : null;
}

/** An Open now with no end: the coming window's close when it opens within 6 h, else two hours. */
export function defaultOpenUntil(row: HoursFields, now: number): number {
  const hours = storedHours(row.hours);
  const plain = now + DEFAULT_OPEN_MS;
  if (hours === null || hours === 'invalid') return plain;
  const at = nextOpen([hours], row.time_zone, now);
  if (at === null || at - now > EARLY_START_MS) return plain;
  const end = closesAt([hours], row.time_zone, at);
  return end === null ? plain : Math.min(end, now + HOLD_MAX_MS);
}

/** The next instant the open state may change: the hold's end or an hours edge. Null: none. */
export function nextEdgeAt(row: HoursFields, now: number): number | null {
  const edges: number[] = [];
  const hold = activeHold(row.hold, now);
  if (hold) edges.push(hold.until);
  const hours = storedHours(row.hours);
  if (hours !== null && hours !== 'invalid') {
    const flip = nextFlip([hours], row.time_zone, now);
    if (flip !== null) edges.push(flip);
  }
  return edges.length > 0 ? Math.min(...edges) : null;
}

/** Refuses a scan outside the session's hours. */
export function assertSessionOpen(row: HoursFields, now: number): void {
  if (!sessionWindow(row, now).open)
    throw new ForbiddenError('Scanning is closed now.', 'SCANNING_SESSION_CLOSED');
}
