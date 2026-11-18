// Occupancy on the scan grant (SA §20.4-20.8): entry, exit and undo statements added to a caller's grant,
// the reads that name a lost entry's reason, and In now with revisions.
import type { Grant } from '../../../platform/authority.ts';
import type { AfterRead } from '../../../platform/authority-after.ts';
import { exists, type GrantCond, not } from '../../../platform/authority-cond.ts';
import { orgZoneRows } from '../repo-zones.ts';
import { effectiveTimeZone, indexZones } from '../zones-tree.ts';
import * as repo from './repo.ts';
import {
  dueAt,
  type EntryPlan,
  type ExitPlan,
  entryReason,
  type LossRead,
  type LossRow,
  type OccZone,
  type Waivers,
  zonePlace,
} from './rules.ts';

/** The pass is of the grant's org and mode: the one check an exit never skips (OC4). */
const ofTenant = (passId: string): GrantCond => exists('passes', { id: passId });

export const occupancyZones = (db: D1Database, orgId: string): Promise<OccZone[]> =>
  orgZoneRows(db, orgId);

export interface EntryInput {
  passId: string;
  scanId: string;
  now: number;
  plan: EntryPlan;
  waivers?: Waivers;
  /** AX's re-entry wait, from the last entry at this place. */
  waitMs?: number | null;
  /** AX's visit limit: holds when another visit is allowed (read in the same statement). */
  limit?: GrantCond | null;
}

export interface Moved {
  /** This scan moved the place: gates the visit, finalize and ledger. */
  won: GrantCond;
  /** Places whose revision this batch raises when it wins. */
  places: string[];
}

/**
 * ENTER, ENTER_IMPLIED, EXIT_BELOW and REV. The entry is one statement whose conditions are the
 * parent, inside, wait, limit and capacity rules, each skipped only by its own waiver; the rest
 * follow only if it moved.
 */
export function addEntry(g: Grant, i: EntryInput): Moved {
  const { passId, scanId, now, plan } = i;
  const w = i.waivers ?? {};
  const conds: GrantCond[] = [ofTenant(passId)];
  if (plan.parent) conds.push(repo.insideOf(passId, plan.parent, now));
  if (i.waitMs && !w.wait) conds.push(repo.waitedSince(passId, plan.place, now - i.waitMs));
  if (i.limit && !w.limit) conds.push(i.limit);
  const room = w.cap
    ? []
    : [plan, ...plan.implied].flatMap((p) =>
        p.capacity === null ? [] : [repo.roomIn(passId, p.place, p.capacity, now)],
      );
  const inside = repo.insideOf(passId, plan.place, now);
  const row = { passId, place: plan.place, scanId, now, dueAt: plan.dueAt };
  // A track-only repeat keeps `since`; it runs first, so the fresh entry below sees it inside.
  if (!plan.enforce && !w.inside)
    repo.enterRow(g, { ...row, keep: true, when: [...conds, inside] });
  const fresh = w.inside ? [] : [not(inside)];
  repo.enterRow(g, { ...row, when: [...conds, ...room, ...fresh] });
  const won = repo.wrote(passId, plan.place, scanId);
  for (const up of plan.implied)
    repo.enterRow(g, {
      passId,
      place: up.place,
      scanId,
      now,
      dueAt: up.dueAt,
      when: [won, not(repo.insideOf(passId, up.place, now))],
    });
  const overIn = repo.wroteOverIn(passId, plan.place, scanId);
  for (const place of plan.below)
    repo.exitRow(g, { passId, place, scanId, now, when: [overIn, repo.inRow(passId, place)] });
  const places = [plan.place, ...plan.implied.map((p) => p.place), ...plan.below];
  for (const place of places) repo.bumpRev(g, place, [won]);
  return { won, places };
}

/**
 * EXIT, EXIT_BELOW and REV. A scan exits a live in row; the cron (`lastScanId`) exits the in row it
 * read, past due or not, and loses to any tap since.
 */
export function addExit(
  g: Grant,
  i: { passId: string; scanId: string; now: number; plan: ExitPlan; lastScanId?: string },
): Moved {
  const { passId, scanId, now, plan } = i;
  const held = i.lastScanId
    ? repo.inRow(passId, plan.place, i.lastScanId)
    : repo.insideOf(passId, plan.place, now);
  repo.exitRow(g, { passId, place: plan.place, scanId, now, when: [ofTenant(passId), held] });
  const won = repo.wrote(passId, plan.place, scanId);
  for (const place of plan.below)
    repo.exitRow(g, { passId, place, scanId, now, when: [won, repo.inRow(passId, place)] });
  const places = [plan.place, ...plan.below];
  for (const place of places) repo.bumpRev(g, place, [won]);
  return { won, places };
}

export interface UndoInput {
  passId: string;
  /** The scans undone together (an override's forced exit and grant share a group). */
  group: readonly string[];
  /** The latest scan of the group: a change by any later scan supersedes the undo. */
  after: { at: number; id: string };
  /** Every row the group wrote, read before the batch (`readGroupRows`). */
  rows: readonly repo.OccupancyRow[];
  zones: readonly OccZone[];
  /** The session's clock, when no root zone has one. */
  timeZone: string | null;
}

/**
 * Restore every row the group wrote, all or nothing: one guard and an exact match per row refuse the
 * whole batch (`lineage`) when anything changed since. Rows going back in get their due time again;
 * each restored place's revision goes up.
 */
export function addUndo(g: Grant, i: UndoInput): { places: string[] } {
  const ok = repo.undoStillApplies(i.passId, i.group, i.rows.length, i.after);
  g.assert('lineage', ok);
  const index = indexZones(i.zones);
  for (const row of i.rows) {
    const zone = i.zones.find((z) => zonePlace(z.id) === row.scope);
    const back =
      zone && row.prev_state === 'in' && row.prev_entered_at !== null
        ? dueAt(zone, row.prev_entered_at, effectiveTimeZone(index, zone.id) ?? i.timeZone)
        : null;
    repo.undoRow(g, row, back);
  }
  const places = [...new Set(i.rows.map((r) => r.scope))];
  for (const place of places) repo.bumpRev(g, place, []);
  return { places };
}

export async function readGroupRows(
  db: D1Database,
  orgId: string,
  passId: string,
  group: readonly string[],
): Promise<repo.OccupancyRow[]> {
  const [r] = await repo.runReads(db, [repo.groupRowsRead(orgId, passId, group)]);
  return (r?.results ?? []) as repo.OccupancyRow[];
}

/** Reads for `commitWith`: the pass's rows and the capacity places' counts after the batch. */
export function lossReads(
  orgId: string,
  mode: string,
  passId: string,
  plan: EntryPlan,
  now: number,
): AfterRead[] {
  const places = [
    plan.place,
    ...(plan.parent ? [plan.parent] : []),
    ...plan.implied.map((p) => p.place),
  ];
  const caps = [plan, ...plan.implied].filter((p) => p.capacity !== null).map((p) => p.place);
  return [
    repo.rowsRead(orgId, passId, places),
    ...(caps.length ? [repo.countsRead(orgId, mode, caps, now)] : []),
  ];
}

export function lossOf(results: readonly D1Result[]): LossRead {
  const counts = new Map<string, number>();
  for (const c of (results[1]?.results ?? []) as { place: string; n: number }[])
    counts.set(c.place, c.n);
  return { rows: (results[0]?.results ?? []) as LossRow[], counts };
}

/** Why the entry lost, from `lossReads` run in the same batch. */
export const lostEntry = (
  plan: EntryPlan,
  results: readonly D1Result[],
  now: number,
  o: Parameters<typeof entryReason>[3] = {},
) => entryReason(plan, lossOf(results), now, o);

export interface PlaceCount {
  place: string;
  inNow: number;
  rev: number;
}

/** COUNTS: In now and the revision of each place, for monitors (after the batch, in it). */
export const countReads = (
  orgId: string,
  mode: string,
  places: readonly string[],
  now: number,
): AfterRead[] =>
  places.length
    ? [repo.countsRead(orgId, mode, places, now), repo.revsRead(orgId, mode, places)]
    : [];

export function placeCounts(places: readonly string[], results: readonly D1Result[]): PlaceCount[] {
  const n = new Map(
    ((results[0]?.results ?? []) as { place: string; n: number }[]).map((r) => [r.place, r.n]),
  );
  const rev = new Map(
    ((results[1]?.results ?? []) as { place: string; rev: number }[]).map((r) => [r.place, r.rev]),
  );
  return places.map((place) => ({ place, inNow: n.get(place) ?? 0, rev: rev.get(place) ?? 0 }));
}

/** A zone stopped tracking, was archived or moved: everyone inside it and below falls due now. */
export const addZoneTapOut = (g: Grant, places: readonly string[], now: number) =>
  repo.dueNow(g, places, now);
