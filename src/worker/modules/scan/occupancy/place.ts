// What a scan counts at: a tracked zone with its tree, or a re-entry event (one node, no tree). The
// builder takes either; zone logic stays in `rules.ts`.
import type { ScanEventRow } from '../repo-scope.ts';
import {
  type EntryPlan,
  type ExitPlan,
  eventPlace,
  type OccZone,
  hardLimited as zoneHardLimited,
  zonePlace,
} from './rules.ts';

export type PlaceSpec =
  | { kind: 'zone'; zones: OccZone[]; zone: OccZone }
  | { kind: 'event'; event: ScanEventRow };

export const specPlace = (s: PlaceSpec): string =>
  s.kind === 'zone' ? zonePlace(s.zone.id) : eventPlace(s.event.id);

export const specCapacity = (s: PlaceSpec): number | null =>
  s.kind === 'zone' ? s.zone.capacity : s.event.capacity;

/** Whether Full is final here: the zone or an ancestor, or the event, has a Hard limit. */
export const hardLimited = (s: PlaceSpec): boolean =>
  s.kind === 'zone' ? zoneHardLimited(s.zones, s.zone.id) : s.event.hardLimit === true;

/**
 * Entering an event: it enforces tap out and has no parent, implied or lower place and no due time.
 * Its zone fence is empty: the grant holds the event's `config_epoch`. Capacity is the event's own
 * count (`capacityFullPredicate`), not a live row count, so the plan carries none.
 */
export const eventEntryPlan = (e: Pick<ScanEventRow, 'id'>): EntryPlan => ({
  place: eventPlace(e.id),
  capacity: null,
  dueAt: null,
  enforce: true,
  parent: null,
  implied: [],
  below: [],
  zones: [],
});

export const eventExitPlan = (e: Pick<ScanEventRow, 'id'>): ExitPlan => ({
  place: eventPlace(e.id),
  below: [],
});
