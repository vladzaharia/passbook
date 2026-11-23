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

const instant = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Moments a built pass changes with no edit: each upcoming event starts and ends (the active mark and
 * the next-event highlight move), and optionally the pass expires. One calculation for Apple's
 * timed refresh and for the Google and Samsung instances. Sorted, no duplicates.
 */
export function passBoundaries(
  pass: string | PassLike | null,
  options: BoundaryOptions = {},
): number[] {
  let json: PassLike;
  try {
    json = typeof pass === 'string' ? JSON.parse(pass) : (pass ?? {});
  } catch {
    return [];
  }
  if (typeof json !== 'object' || json === null) return [];
  const fallback = (options.fallbackMinutes ?? DEFAULT_EVENT_MINUTES) * MINUTE;
  const times: (number | undefined)[] = options.expiry ? [instant(json.expirationDate)] : [];
  const events = Array.isArray(json.upcomingPassInformation) ? json.upcomingPassInformation : [];
  for (const event of events) {
    const start = instant(event?.dateInformation?.date);
    if (start === undefined) continue;
    const end = instant(event?.semantics?.eventEndDate);
    // An event still runs at its end instant, so it is over one millisecond later.
    times.push(start, (end !== undefined && end >= start ? end : start + fallback) + 1);
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
