import type { ScanOccupancy, ScanReason } from '../../../shared/contracts/scan.ts';
import type { Grant } from '../../platform/authority.ts';
import type { AfterRead } from '../../platform/authority-after.ts';
import { type GrantCond, not } from '../../platform/authority-cond.ts';
import { waiveOf } from './access.ts';
import type { FoundAccess } from './access-types.ts';
import { type FoundOccupancy, occupancyView, occupancyWaivers } from './occupancy/admission.ts';
import { eventEntryPlan, eventExitPlan, hardLimited } from './occupancy/place.ts';
import { insideOf, roomIn } from './occupancy/repo.ts';
import {
  type EntryPlan,
  type ExitPlan,
  entryPlan,
  exitPlan,
  type Waivers,
} from './occupancy/rules.ts';
import {
  addEntry,
  addExit,
  countReads,
  lossReads,
  lostEntry,
  type Moved,
  placeCounts,
} from './occupancy/service.ts';
import { accessQuiet, accessVisitOpen } from './repo-access.ts';
import { capacityFullPredicate } from './repo-gates.ts';
import type { ScanPresenceSnapshot } from './repo-scan-effect.ts';
import { presenceSnapshot } from './repo-scan-effect-snapshots.ts';
import { capacityOpen } from './scan-write-grant.ts';
import { allOf } from './scan-write-statements.ts';

/** One reason a scan that did not move its place is held, and the condition that held it back. */
interface OccupancyHold {
  reason: ScanReason;
  outcome?: 'refused';
  /** True while this rule lets the entry through. */
  holds: GrantCond;
}

/** A check-in at a tracked zone, planned from what the scan read (SA §20.4). */
export interface OccupancyCommit {
  found: FoundOccupancy;
  passId: string;
  scanId: string;
  now: number;
  entry: EntryPlan | null;
  exit: ExitPlan | null;
  waivers: Waivers;
  /** The entry carries the visit gate's wait and limit, so it never moves unless the gate will. */
  when: GrantCond[];
  /** Step 15's rules in order; the first that fails names the heads-up. */
  holds: OccupancyHold[];
}

/**
 * The entry or exit for this scan. An override waives the one reason it names; a Let in anyway on
 * Already in re-enters over the in row (`since` resets, children leave). Null when the place no
 * longer plans (the commit refuses as stale).
 */
export function planOccupancyCommit(
  o: FoundOccupancy,
  i: {
    passId: string;
    scanId: string;
    now: number;
    access: FoundAccess | null;
    override: string | null;
    open: GrantCond[];
    /** An exit's gate as the scan read it: the row moves only if the gate write will. */
    gateAsRead: GrantCond | null;
    /** At an event: a single or daily limit's snapshot and since checks, repeated in the entry. */
    limit?: GrantCond[];
  },
): OccupancyCommit | null {
  const { passId, scanId, now } = i;
  const base = { found: o, passId, scanId, now };
  const spec = o.spec;
  if (o.direction === 'out') {
    const exit =
      spec.kind === 'zone' ? exitPlan(spec.zones, spec.zone.id) : eventExitPlan(spec.event);
    if (!exit) return null;
    const holds = [{ reason: 'not_inside' as const, holds: insideOf(passId, exit.place, now) }];
    return {
      ...base,
      entry: null,
      exit,
      waivers: {},
      when: [...i.open, ...(i.gateAsRead ? [i.gateAsRead] : [])],
      holds,
    };
  }
  const waived = occupancyWaivers(i.override);
  // A Hard limit is never waived, whatever the override and its approver said.
  const waivers = waived.cap && hardLimited(spec) ? { ...waived, cap: false } : waived;
  if (spec.kind === 'event') {
    // An event's room is its own count (arrivals, or inside with re-entry), so it rides in `when`.
    const e = spec.event;
    const full =
      e.capacity !== null && !waivers.cap
        ? capacityOpen(capacityFullPredicate(e.orgId, e.mode, e.id, e.capacity, e.reentry, passId))
        : null;
    const entry = eventEntryPlan(e);
    const holds: OccupancyHold[] = [
      ...(waivers.inside
        ? []
        : [{ reason: 'still_inside' as const, holds: not(insideOf(passId, entry.place, now)) }]),
      ...(full ? [{ reason: 'capacity_full' as const, holds: full }] : []),
    ];
    const when = [...(i.limit ?? []), ...(full ? [full] : []), ...i.open];
    return { ...base, entry, exit: null, waivers, when, holds };
  }
  const access = i.access;
  if (!access) return null;
  const entry = entryPlan(spec.zones, spec.zone.id, now, null, waivers);
  if (!entry) return null;
  const waive = waiveOf(i.override);
  const wait = waive.wait ? null : access.waitMs;
  const quiet = accessQuiet(passId, now, wait);
  const visit =
    access.limit !== null && !waive.limit
      ? accessVisitOpen(passId, now, access.gapMs, access.limit)
      : null;
  const room = waivers.cap
    ? []
    : [entry, ...entry.implied].flatMap((p) =>
        p.capacity === null ? [] : [roomIn(passId, p.place, p.capacity, now)],
      );
  const holds: OccupancyHold[] = [
    ...(entry.parent
      ? [{ reason: 'not_inside' as const, holds: insideOf(passId, entry.parent, now) }]
      : []),
    ...(entry.enforce && !waivers.inside
      ? [{ reason: 'still_inside' as const, holds: not(insideOf(passId, entry.place, now)) }]
      : []),
    ...(wait !== null ? [{ reason: 'cooldown' as const, holds: quiet }] : []),
    ...(visit
      ? [{ reason: 'guest_visits_used' as const, outcome: 'refused' as const, holds: visit }]
      : []),
    ...(room.length ? [{ reason: 'capacity_full' as const, holds: allOf(room) }] : []),
  ];
  const when = [quiet, ...(visit ? [visit] : []), ...i.open];
  return { ...base, entry, exit: null, waivers, when, holds };
}

/**
 * The place's row before and after, for the signed effect: the scan's own row (`presence_scope`). A
 * track-only repeat keeps `since`; the batch decides, this is what the scan read and asked for.
 */
export function occupancyEffect(
  o: FoundOccupancy,
  i: { orgId: string; passId: string; scanId: string; now: number; keep: boolean },
): { presenceBefore: ScanPresenceSnapshot | null; presenceAfter: ScanPresenceSnapshot } {
  const before = presenceSnapshot(o.row);
  const entry = o.direction === 'in';
  return {
    presenceBefore: before,
    presenceAfter: {
      passId: i.passId,
      orgId: i.orgId,
      scope: o.place,
      state: o.direction,
      tracking: 1,
      enteredAt: entry ? (i.keep ? (before?.enteredAt ?? i.now) : i.now) : null,
      firstAt: before?.firstAt ?? i.now,
      lastEntryAt: entry || !before ? i.now : before.lastEntryAt,
      lastScanId: i.scanId,
      prevState: before?.state ?? null,
      prevTracking: before?.tracking ?? null,
      prevEnteredAt: before?.enteredAt ?? null,
      prevFirstAt: before?.firstAt ?? null,
      prevLastEntryAt: before?.lastEntryAt ?? null,
      prevScanId: before?.lastScanId ?? null,
    },
  };
}

/** ENTER (with its implied and below rows) or EXIT, and REV: `won` gates the rest of the batch. */
export function addOccupancy(g: Grant, c: OccupancyCommit): Moved {
  const { passId, scanId, now } = c;
  if (c.entry)
    return addEntry(g, { passId, scanId, now, plan: c.entry, waivers: c.waivers, when: c.when });
  return addExit(g, { passId, scanId, now, plan: c.exit as ExitPlan, when: c.when });
}

/** Read with the commit: a lost entry's rows and counts, and the place's In now with its revision. */
export function occupancyReads(
  orgId: string,
  mode: string,
  c: OccupancyCommit,
): { reads: AfterRead[]; loss: number } {
  const loss = c.entry ? lossReads(orgId, mode, c.passId, c.entry, c.now) : [];
  return {
    reads: [...loss, ...countReads(orgId, mode, [c.found.place], c.now)],
    loss: loss.length,
  };
}

/**
 * What the answer says about the place after the batch: the row as this scan left it (or as read,
 * when it moved nothing), the count, and why a lost entry was held (`lostEntry`, in step 15's order).
 */
export function occupancyAfter(
  c: OccupancyCommit,
  results: readonly D1Result[],
  loss: number,
  won: boolean,
  scannerName: string | null,
): { view: ScanOccupancy; lost: ScanReason | null; hard: boolean } {
  const o = c.found;
  const [count] = placeCounts([o.place], results.slice(loss));
  const inNow = count?.inNow ?? null;
  const kept = won && !!c.entry && !c.entry.enforce && !c.waivers.inside && o.inside;
  const enteredAt = o.row?.entered_at ?? null;
  const state: 'in' | 'out' = won ? (c.entry ? 'in' : 'out') : o.inside ? 'in' : 'out';
  const since = !won
    ? o.inside
      ? enteredAt
      : (o.row?.changed_at ?? null)
    : kept
      ? enteredAt
      : c.now;
  const stayMs = won && c.exit && enteredAt !== null ? c.now - enteredAt : null;
  const why =
    !won && c.entry
      ? lostEntry(c.entry, results.slice(0, loss), c.now, { waivers: c.waivers })
      : null;
  return {
    view: occupancyView(o, {
      state,
      since,
      stayMs,
      inNow,
      via: won ? scannerName : (o.row?.via ?? null),
    }),
    lost: why?.reason ?? null,
    hard: hardLimited(o.spec),
  };
}
