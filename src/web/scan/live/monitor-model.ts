import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';

export const TREND_MS = 15 * 60_000;

/** A lower revision never replaces a higher one. */
export function mergePlaces(
  previous: ScanPlaceRev[],
  incoming: ScanPlaceRev[] | undefined,
): ScanPlaceRev[] {
  if (!incoming?.length) return previous;
  const byKey = new Map(previous.map((p) => [p.place, p]));
  for (const place of incoming) {
    const held = byKey.get(place.place);
    if (!held || place.rev >= held.rev) byKey.set(place.place, place);
  }
  return [...byKey.values()];
}

export interface Trend {
  entered: number;
  left: number;
}

/** Entries and exits in the last 15 minutes, from rows that went through. */
export function trendOf(rows: ScanLiveRow[], now: number): Trend {
  let entered = 0;
  let left = 0;
  for (const row of rows) {
    if (row.kind !== 'ok' || now - row.at >= TREND_MS) continue;
    if (row.direction === 'in') entered += 1;
    else if (row.direction === 'out') left += 1;
  }
  return { entered, left };
}

export type Fill = 'open' | 'busy' | 'full';
export interface Hero {
  name: string | null;
  count: number;
  capacity: number | null;
  fill: Fill;
  /** 0 to 1 of capacity, null without one. */
  ratio: number | null;
}

/** The counts to show: the pushed places, else what the newest rows said. */
export function countsOf(places: ScanPlaceRev[], rows: ScanLiveRow[]): ScanPlaceRev[] {
  if (places.length) return places;
  const seen = new Map<string, ScanPlaceRev>();
  for (const row of rows) {
    const o = row.occupancy;
    if (!o || o.inNow === null) continue;
    const key = `${o.place.kind}:${o.place.id}`;
    if (!seen.has(key))
      seen.set(key, {
        place: key,
        name: o.place.name,
        inNow: o.inNow,
        capacity: o.capacity,
        rev: 0,
      });
  }
  return [...seen.values()];
}

/** The first place leads (tree order); the others are small tiles. */
export function heroOf(counts: ScanPlaceRev[]): Hero | null {
  const first = counts[0];
  if (!first) return null;
  const ratio = first.capacity ? first.inNow / first.capacity : null;
  const fill: Fill = ratio === null ? 'open' : ratio >= 1 ? 'full' : ratio >= 0.9 ? 'busy' : 'open';
  return { name: first.name, count: first.inNow, capacity: first.capacity, fill, ratio };
}
