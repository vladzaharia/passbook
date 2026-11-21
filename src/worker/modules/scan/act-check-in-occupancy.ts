import type { ScanOccupancy, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { Grant } from '../../platform/authority.ts';
import type { AfterRead } from '../../platform/authority-after.ts';
import { exists, type GrantCond, not, notExists } from '../../platform/authority-cond.ts';
import { waiveOf } from './access.ts';
import type { FoundAccess } from './access-types.ts';
import type { AdmissionPlan } from './admission-types.ts';
import { localDayStart } from './counts.ts';
import { type FoundOccupancy, occupancyView, occupancyWaivers } from './occupancy/admission.ts';
import { eventEntryPlan, eventExitPlan, hardLimited } from './occupancy/place.ts';
import { insideOf, roomIn, waitedSince } from './occupancy/repo.ts';
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
import { admissionConds, allOf } from './scan-write-statements.ts';

/** One reason a scan that did not move its place is held, and the condition that held it back. */
interface OccupancyHold {
  reason: ScanReason;
  outcome?: 'refused';
  /** True while this rule lets the entry through. */
  holds: GrantCond;
}

type EventRepeat = { kind: 'daily'; dayStart: number } | { kind: 'cooldown'; ms: number } | null;

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
    /** At an event: a single or daily limit's since checks, repeated in the entry. */
    limit?: GrantCond[];
    /** At an event: the presence row is still the one the scan read and signed (no ABA). */
    cas?: GrantCond;
    /** At an event: the action's own repeat rule, which the place does not carry. */
    repeat?: EventRepeat;
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
      when: [
        ...(spec.kind === 'event' && i.cas ? [i.cas] : []),
        ...i.open,
        ...(i.gateAsRead ? [i.gateAsRead] : []),
      ],
      holds,
    };
  }
  const waived = occupancyWaivers(i.override);
  // A Hard limit is never waived, whatever the override and its approver said.
  const capWaivers = waived.cap && hardLimited(spec) ? { ...waived, cap: false } : waived;
  // A daily ticket's in row from an earlier day does not hold today's entry.
  const stale =
    spec.kind === 'event' &&
    i.repeat?.kind === 'daily' &&
    o.inside &&
    (o.row?.entered_at ?? now) < i.repeat.dayStart;
  const waivers = stale ? { ...capWaivers, inside: true } : capWaivers;
  if (spec.kind === 'event') {
    // An event's room is its own count (arrivals, or inside with re-entry), so it rides in `when`.
    const e = spec.event;
    const full =
      e.capacity !== null && !waivers.cap
        ? capacityOpen(capacityFullPredicate(e.orgId, e.mode, e.id, e.capacity, e.reentry, passId))
        : null;
    const entry = eventEntryPlan(e);
    const r = i.repeat;
    const rule =
      r?.kind === 'daily' && i.override !== 'already_done'
        ? {
            reason: 'already_done' as const,
            holds: waitedSince(passId, entry.place, r.dayStart - 1),
          }
        : r?.kind === 'cooldown' && i.override !== 'cooldown'
          ? { reason: 'cooldown' as const, holds: waitedSince(passId, entry.place, now - r.ms) }
          : null;
    const holds: OccupancyHold[] = [
      ...(waivers.inside
        ? []
        : [{ reason: 'still_inside' as const, holds: not(insideOf(passId, entry.place, now)) }]),
      ...(rule ? [{ reason: rule.reason, holds: rule.holds }] : []),
      ...(full ? [{ reason: 'capacity_full' as const, holds: full }] : []),
    ];
    const when = [
      ...(i.cas ? [i.cas] : []),
      ...(i.limit ?? []),
      ...(rule ? [rule.holds] : []),
      ...(full ? [full] : []),
      ...i.open,
    ];
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

/** What an event place's entry repeats from the scan: the limit, the row it read and the action's rule. */
export function eventPlaceInputs(
  o: FoundOccupancy | null,
  passId: string,
  plan: AdmissionPlan | undefined,
  before: ScanPresenceSnapshot | null,
  action: Pick<ResolvedScanAction, 'repeat' | 'cooldownMinutes'>,
  now: number,
): { limit?: GrantCond[]; cas?: GrantCond; repeat?: EventRepeat } {
  if (o?.spec.kind !== 'event') return {};
  const entering = o.direction === 'in';
  const row = { pass_id: passId, scope: o.place };
  const tz = o.spec.event.timeZone;
  return {
    limit: entering && plan?.limited ? admissionConds(passId, plan, before) : [],
    cas: before
      ? exists('scan_presence', { ...row, last_scan_id: before.lastScanId })
      : notExists('scan_presence', row),
    repeat: !entering
      ? null
      : action.repeat === 'daily'
        ? { kind: 'daily', dayStart: localDayStart(now, tz) }
        : action.repeat === 'cooldown'
          ? { kind: 'cooldown', ms: (action.cooldownMinutes ?? 5) * 60_000 }
          : null,
  };
}
