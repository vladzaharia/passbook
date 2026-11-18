// Occupancy rules without I/O (SA §20): places, the entry plan up and down the zone tree, due times,
// Auto direction and the reason a lost entry gets.
import type { ScanReason } from '../../../../shared/contracts/scan.ts';
import type { ZoneRow } from '../repo-zones.ts';
import { effectiveTimeZone, indexZones, subtree } from '../zones-tree.ts';

export type OccZone = Pick<
  ZoneRow,
  | 'id'
  | 'parentId'
  | 'name'
  | 'sort'
  | 'timeZone'
  | 'occupancy'
  | 'capacity'
  | 'maxStayMinutes'
  | 'clearAt'
  | 'archivedAt'
  | 'updatedAt'
>;

/** A zone as the plan read it; the statement re-checks it in the batch. */
export type ZoneFence = Pick<OccZone, 'id' | 'occupancy' | 'parentId' | 'archivedAt'>;

export const zonePlace = (id: string) => `zone:${id}`;
export const eventPlace = (id: string) => `event:${id}`;

/** One waiver per reason, from the actor's rights (SA 2.6). `forced` resets `since` on a re-entry. */
export interface Waivers {
  parent?: boolean;
  inside?: boolean;
  wait?: boolean;
  limit?: boolean;
  cap?: boolean;
}

export interface PlaceStep {
  place: string;
  capacity: number | null;
  dueAt: number | null;
}

export interface EntryPlan extends PlaceStep {
  /** Require tap out: a second entry while inside is held. */
  enforce: boolean;
  /** The nearest ancestor that requires tap out; the pass must be inside it. */
  parent: string | null;
  /** Tracked ancestors entered with it, nearest first, each with its own due time. */
  implied: PlaceStep[];
  /** Tracked places below it, left when it is re-entered over an in row. */
  below: string[];
  /**
   * The zone and every ancestor as read: a racing Track off, archive or move makes the entry lose.
   * Capacity, Max stay, Clear at and the time zone are not fenced: a racing edit of those gives this
   * one entry the old value (plan C6, the R8 class). The count is still exact against the capacity it
   * read, and a due time from old settings is re-armed by the cron's re-read, so nothing lasts.
   */
  zones: ZoneFence[];
}

export interface ExitPlan {
  place: string;
  below: string[];
}

const tracked = (z: OccZone) => z.occupancy !== 'off' && z.archivedAt === null;

/** The zone and its ancestors, nearest first. */
export function zoneChain(zones: readonly OccZone[], id: string): OccZone[] {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const out: OccZone[] = [];
  const seen = new Set<string>();
  for (let at = byId.get(id); at && !seen.has(at.id); at = byId.get(at.parentId ?? '')) {
    out.push(at);
    seen.add(at.id);
  }
  return out;
}

function belowOf(zones: readonly OccZone[], id: string): string[] {
  const byId = new Map(zones.map((z) => [z.id, z]));
  return subtree(indexZones(zones), id)
    .slice(1)
    .flatMap((n) => {
      const z = byId.get(n.id);
      return z && tracked(z) ? [zonePlace(z.id)] : [];
    });
}

/**
 * Entering `zoneId`: null when the zone does not track. Without a parent waiver the tracked
 * ancestors below the nearest enforcing one are implied; with it, every tracked ancestor is (the
 * override enters the parent too). `orgTimeZone` is the org's clock, used when no root zone has one
 * (SA §20.2); without either, Clear at is skipped.
 */
export function entryPlan(
  zones: readonly OccZone[],
  zoneId: string,
  now: number,
  orgTimeZone: string | null,
  waivers: Waivers = {},
): EntryPlan | null {
  const all = zoneChain(zones, zoneId);
  const [zone, ...ancestors] = all;
  if (!zone || !tracked(zone)) return null;
  const clock = effectiveTimeZone(indexZones(zones), zoneId) ?? orgTimeZone;
  const step = (z: OccZone): PlaceStep => ({
    place: zonePlace(z.id),
    capacity: z.capacity,
    dueAt: dueAt(z, now, clock),
  });
  const up = ancestors.filter(tracked);
  const enforcing = up.findIndex((z) => z.occupancy === 'enforce');
  const parent = enforcing < 0 ? null : (up[enforcing] as OccZone);
  const implied = waivers.parent || enforcing < 0 ? up : up.slice(0, enforcing);
  return {
    ...step(zone),
    enforce: zone.occupancy === 'enforce',
    parent: parent && !waivers.parent ? zonePlace(parent.id) : null,
    implied: implied.map(step),
    below: belowOf(zones, zoneId),
    zones: all.map(({ id, occupancy, parentId, archivedAt }) => ({
      id,
      occupancy,
      parentId,
      archivedAt,
    })),
  };
}

/** Leaving `zoneId` leaves every tracked zone below it. Null when the zone does not track. */
export function exitPlan(zones: readonly OccZone[], zoneId: string): ExitPlan | null {
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone || !tracked(zone)) return null;
  return { place: zonePlace(zoneId), below: belowOf(zones, zoneId) };
}

/**
 * Leaving a place as given (the cron, Mark as out): whatever the zone's settings now, every row below
 * it is closed too. An event has nothing below.
 */
export function exitAsGiven(zones: readonly OccZone[], place: string): ExitPlan {
  if (!place.startsWith('zone:')) return { place, below: [] };
  return { place, below: subtreePlaces(zones, place.slice(5)).slice(1) };
}

/** Places whose inside rows end when the zone stops tracking, is archived or moves: it and all below. */
export const subtreePlaces = (zones: readonly OccZone[], zoneId: string): string[] =>
  subtree(indexZones(zones), zoneId).map((n) => zonePlace(n.id));

const formats = new Map<string, Intl.DateTimeFormat>();

/** The wall clock at `t` in `timeZone`, as if it were UTC. */
function wall(t: number, timeZone: string): number {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(
    p.year ?? 0,
    (p.month ?? 1) - 1,
    p.day ?? 1,
    p.hour ?? 0,
    p.minute ?? 0,
    p.second ?? 0,
  );
}

/**
 * The instant the wall clock in `timeZone` reads `local` (a UTC-encoded wall time). A repeated
 * autumn time gives its first instance; a time in the spring gap gives the gap's end.
 */
export function instantOf(local: number, timeZone: string): number {
  const offsets = [local - 86_400_000, local + 86_400_000].map((t) => wall(t, timeZone) - t);
  const tries = [...new Set(offsets)].map((o) => local - o).sort((a, b) => a - b);
  const exact = tries.find((t) => wall(t, timeZone) === local);
  if (exact !== undefined) return exact;
  let lo = tries[0] ?? local;
  let hi = tries[tries.length - 1] ?? local;
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (wall(mid, timeZone) >= local) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The first Clear at strictly after `since`, or null without a clock. */
export function nextClear(clearAt: string, since: number, timeZone: string | null): number | null {
  if (!timeZone) return null;
  const [h, m] = clearAt.split(':').map(Number);
  const day = new Date(wall(since, timeZone));
  for (let add = 0; add < 3; add++) {
    const local = Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate() + add,
      h ?? 0,
      m ?? 0,
    );
    const at = instantOf(local, timeZone);
    if (at > since) return at;
  }
  return null;
}

/** When the system taps the pass out: the earlier of Max stay and the next Clear at. */
export function dueAt(
  zone: Pick<OccZone, 'maxStayMinutes' | 'clearAt'>,
  since: number,
  timeZone: string | null,
): number | null {
  const ends = [
    ...(zone.maxStayMinutes == null ? [] : [since + zone.maxStayMinutes * 60_000]),
    ...(zone.clearAt == null ? [] : [nextClear(zone.clearAt, since, timeZone)]),
  ].filter((t): t is number => t !== null);
  return ends.length ? Math.min(...ends) : null;
}

/** An in row past its due time reads as out everywhere. */
export const liveIn = (row: { state: string; due_at: number | null } | null, now: number) =>
  !!row && row.state === 'in' && (row.due_at === null || row.due_at > now);

export const TURNAROUND_MS = 120_000;

/**
 * The direction of a scan at a place. Auto (a Both scanner, nothing pinned) infers it: inside means
 * out. A flip under two minutes after the last transition is held with the inferred direction offered.
 */
export function scanDirection(i: {
  setting: 'in' | 'out' | 'both';
  requested?: 'in' | 'out' | undefined;
  inside: boolean;
  lastChangeAt: number | null;
  now: number;
}): { direction: 'in' | 'out'; auto: boolean; turnaround: 'in' | 'out' | null } {
  if (i.setting !== 'both') return { direction: i.setting, auto: false, turnaround: null };
  if (i.requested) return { direction: i.requested, auto: false, turnaround: null };
  const direction = i.inside ? 'out' : 'in';
  const recent = i.lastChangeAt !== null && i.now - i.lastChangeAt < TURNAROUND_MS;
  return { direction, auto: true, turnaround: recent ? direction : null };
}

export interface LossRow {
  scope: string;
  state: string;
  due_at: number | null;
  last_entry_at: number;
}

/** What a lost entry reads in the same batch: the pass's rows and the counts of capacity places. */
export interface LossRead {
  rows: readonly LossRow[];
  counts: ReadonlyMap<string, number>;
}

/**
 * Why an entry did not move the place, in step 15's order: parent, inside, wait, limit, capacity.
 * `limitOk` is the caller's visit limit, read in the same batch. Null when nothing explains it.
 */
export function entryReason(
  plan: EntryPlan,
  loss: LossRead,
  now: number,
  o: { waivers?: Waivers; waitMs?: number | null; limitOk?: boolean } = {},
): { reason: ScanReason; fullAt: string | null } | null {
  const w = o.waivers ?? {};
  const row = (place: string) => loss.rows.find((r) => r.scope === place) ?? null;
  const inside = (place: string) => liveIn(row(place), now);
  if (plan.parent && !w.parent && !inside(plan.parent))
    return { reason: 'not_inside', fullAt: null };
  if (plan.enforce && !w.inside && inside(plan.place))
    return { reason: 'still_inside', fullAt: null };
  const last = row(plan.place)?.last_entry_at;
  if (o.waitMs && !w.wait && last != null && last > now - o.waitMs)
    return { reason: 'cooldown', fullAt: null };
  if (o.limitOk === false && !w.limit) return { reason: 'guest_visits_used', fullAt: null };
  if (!w.cap)
    for (const p of [plan, ...plan.implied])
      if (p.capacity !== null && !inside(p.place) && (loss.counts.get(p.place) ?? 0) >= p.capacity)
        return { reason: 'capacity_full', fullAt: p.place };
  return null;
}
