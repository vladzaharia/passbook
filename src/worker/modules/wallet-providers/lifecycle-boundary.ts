import type { ServiceContext } from '../../platform/service-context.ts';
import { currentPassJson } from '../passes/repo-read-pass.ts';

/**
 * Moments at which a compiled wallet card changes with no pass edit: the pass expires, or an upcoming event's
 * date passes and the next one becomes the card's event (architecture 6.1). Apple's wallet does both on the
 * device; Google and Samsung only know what was last sent.
 */
export function passBoundaries(raw: string | null): number[] {
  if (raw === null) return [];
  let pass: {
    expirationDate?: unknown;
    upcomingPassInformation?: { dateInformation?: { date?: unknown } }[];
  };
  try {
    pass = JSON.parse(raw);
  } catch {
    return [];
  }
  const dates = [
    pass.expirationDate,
    ...(Array.isArray(pass.upcomingPassInformation)
      ? pass.upcomingPassInformation.map((event) => event?.dateInformation?.date)
      : []),
  ];
  const times = dates
    .map((date) => (typeof date === 'string' ? Date.parse(date) : Number.NaN))
    .filter(Number.isFinite);
  return [...new Set(times)].sort((a, b) => a - b);
}

/** How many boundaries are behind `now`: part of an operation's identity, so crossing one queues a new one. */
export function boundaryPhase(boundaries: readonly number[], now: number): number {
  return boundaries.filter((at) => at <= now).length;
}

export function nextBoundary(boundaries: readonly number[], now: number): number | null {
  return boundaries.find((at) => at > now) ?? null;
}

/** When the instance's card next changes by itself: the drain parks the instance's dirty row until then. */
export async function nextInstanceBoundary(
  ctx: ServiceContext,
  passId: string,
): Promise<number | null> {
  return nextBoundary(passBoundaries(await currentPassJson(ctx.env.DB, passId)), ctx.clock.now());
}
