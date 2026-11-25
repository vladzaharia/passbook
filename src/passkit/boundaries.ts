/** Minutes an event without an end counts as running (`upcoming-events` `fallbackMinutes` default). */
export const DEFAULT_EVENT_MINUTES = 180;
const MINUTE = 60_000;

export interface BoundaryOptions {
  /** The template's `fallbackMinutes`; events without an `eventEndDate` end this long after the start. */
  fallbackMinutes?: number;
  /** Count the pass's own `expirationDate` (wallets that cannot expire a card themselves). */
  expiry?: boolean;
}

interface PassLike {
  expirationDate?: unknown;
  upcomingPassInformation?: unknown;
}

/** A date with a time and a zone; a date-only value (an all-day event) has no instant of its own. */
const ZONED = /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i;

const instant = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' && ZONED.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

const parse = (pass: string | PassLike | null): PassLike | null => {
  try {
    const json: unknown = typeof pass === 'string' ? JSON.parse(pass) : (pass ?? {});
    return typeof json === 'object' && json !== null ? (json as PassLike) : null;
  } catch {
    return null;
  }
};

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (typeof v === 'object' && v !== null ? (v as Dict) : {});

/**
 * Start and end of each event a built pass lists, in list order. An undetermined or all-day event
 * has no start. An event still runs at its end instant; without an end it runs `fallbackMinutes`.
 */
export function listedEventTimes(
  pass: string | PassLike | null,
  options: Pick<BoundaryOptions, 'fallbackMinutes'> = {},
): { start: number | undefined; until: number | undefined }[] {
  const json = parse(pass);
  const events = Array.isArray(json?.upcomingPassInformation) ? json.upcomingPassInformation : [];
  const fallback = (options.fallbackMinutes ?? DEFAULT_EVENT_MINUTES) * MINUTE;
  return events.map((raw) => {
    const date = dict(dict(raw).dateInformation);
    const start = date.isAllDay === true ? undefined : instant(date.date);
    if (start === undefined) return { start, until: undefined };
    const end = instant(dict(dict(raw).semantics).eventEndDate);
    return { start, until: end !== undefined && end >= start ? end : start + fallback };
  });
}

/**
 * Moments a built pass changes with no edit: each upcoming event starts and ends (the active mark and
 * the next-event highlight move), and optionally the pass expires. One calculation for Apple's
 * timed renders and for the Google and Samsung instances. Sorted, no duplicates.
 */
export function passBoundaries(
  pass: string | PassLike | null,
  options: BoundaryOptions = {},
): number[] {
  const json = parse(pass);
  if (!json) return [];
  const times: (number | undefined)[] = options.expiry ? [instant(json.expirationDate)] : [];
  for (const { start, until } of listedEventTimes(json, options)) {
    if (start === undefined || until === undefined) continue;
    // An event still runs at its end instant, so it is over one millisecond later.
    times.push(start, until + 1);
  }
  return [...new Set(times.filter((t): t is number => t !== undefined))].sort((a, b) => a - b);
}

/** The first boundary after `now`. */
export function nextBoundary(boundaries: readonly number[], now: number): number | null {
  return boundaries.find((at) => at > now) ?? null;
}

/** How many boundaries are behind `now`: a state key that changes each time one is crossed. */
export function boundaryPhase(boundaries: readonly number[], now: number): number {
  return boundaries.filter((at) => at <= now).length;
}
