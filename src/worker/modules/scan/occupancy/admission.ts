// A scan's place and direction (SA §20.3, step 9a): the session's first tracked zone, Auto from the
// pass's row there, the turnaround hold, and what the answer says about the place.
import type { ScanOccupancy } from '../../../../shared/contracts/scan.ts';
import type { PlaceRow } from './repo-reads.ts';
import { liveIn, type OccZone, scanDirection, type Waivers, zonePlace } from './rules.ts';

/** Where a scan counts and which way, as read before its batch. */
export interface FoundOccupancy {
  /** The org's zones as read: the entry and exit plans are made from these. */
  zones: OccZone[];
  zone: OccZone;
  place: string;
  direction: 'in' | 'out';
  auto: boolean;
  row: PlaceRow | null;
  inside: boolean;
  /** The org's clock, for a Clear at whose root zone has none. */
  orgTimeZone: string | null;
}

const tracks = (z: OccZone) => z.occupancy !== 'off' && z.archivedAt === null;

/** The session's place: its first zone, in its order, that tracks. Null: the scan counts nowhere. */
function scanPlace(zones: readonly OccZone[], zoneIds: readonly string[]): OccZone | null {
  for (const id of zoneIds) {
    const zone = zones.find((z) => z.id === id);
    if (zone && tracks(zone)) return zone;
  }
  return null;
}

/**
 * Step 9a: the request's direction, else the scanner's, else Auto from the row (inside means out).
 * `turnaround` is set when Auto would flip a transition under two minutes old: the scan is held.
 * A row past due was closed by the clock, not a person, so it never holds a flip.
 */
export function planOccupancy(i: {
  zones: OccZone[];
  zoneIds: readonly string[];
  rows: readonly PlaceRow[];
  setting: 'in' | 'out' | 'both' | undefined;
  requested: 'in' | 'out' | undefined;
  now: number;
  orgTimeZone: string | null;
}): { found: FoundOccupancy; turnaround: 'in' | 'out' | null } | null {
  const zone = scanPlace(i.zones, i.zoneIds);
  if (!zone) return null;
  const place = zonePlace(zone.id);
  const row = i.rows.find((r) => r.scope === place) ?? null;
  const inside = liveIn(row, i.now);
  const pastDue = row?.state === 'in' && !inside;
  const d = scanDirection({
    setting: i.setting ?? 'in',
    requested: i.requested,
    inside,
    lastChangeAt: row === null || pastDue ? null : row.changed_at,
    now: i.now,
  });
  return {
    found: {
      zones: i.zones,
      zone,
      place,
      direction: d.direction,
      auto: d.auto,
      row,
      inside,
      orgTimeZone: i.orgTimeZone,
    },
    turnaround: d.turnaround,
  };
}

/** The scanner and the person signed in on it, as Who's in and the result name who moved a pass. */
export const viaName = (scanner: string | null | undefined, staff: string | null | undefined) =>
  [scanner, staff].filter(Boolean).join(' · ') || null;

/** What an override lets through at a place: it names one reason, and only that one is waived. */
export const occupancyWaivers = (reason: string | null | undefined): Waivers => ({
  parent: reason === 'not_inside',
  inside: reason === 'still_inside',
  cap: reason === 'capacity_full',
});

/** The answer's view of the place: the scan's direction, the row now and the count, if read. */
export function occupancyView(
  o: FoundOccupancy,
  at: {
    state: 'in' | 'out';
    since: number | null;
    stayMs: number | null;
    inNow: number | null;
    via: string | null;
  },
  turnaround: 'in' | 'out' | null = null,
): ScanOccupancy {
  return {
    place: { kind: 'zone', id: o.zone.id, name: o.zone.name },
    direction: o.direction,
    auto: o.auto,
    ...at,
    capacity: o.zone.capacity,
    turnaround,
  };
}

/** The view before any write: where the pass is as read. */
export const occupancyAsRead = (o: FoundOccupancy, turnaround: 'in' | 'out' | null = null) =>
  occupancyView(
    o,
    {
      state: o.inside ? 'in' : 'out',
      since: o.inside ? (o.row?.entered_at ?? null) : (o.row?.changed_at ?? null),
      stayMs: null,
      inNow: null,
      via: o.row?.via ?? null,
    },
    turnaround,
  );
