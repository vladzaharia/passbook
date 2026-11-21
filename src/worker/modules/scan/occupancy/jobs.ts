// Minute cron `scan.occupancy` (SA §20.8): taps out passes whose Max stay or Clear at has passed, and
// those inside a zone that stopped tracking, was archived or moved. 200 rows a run, 25 grants a batch.
import { type Grant, grantedBatch } from '../../../platform/authority.ts';
import { AppError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { readOrgTimeZone } from '../repo-org-clock.ts';
import { InvalidScanRetentionProof } from '../scan-retention-proof.ts';
import { effectiveTimeZone, indexZones } from '../zones-tree.ts';
import { exitGrant, type OutCause, rearmGrant } from './auto-exit.ts';
import { type DueRow, dueRows, stayKey } from './repo-reads.ts';
import {
  dueAt,
  exitAsGiven,
  nextClear,
  type OccZone,
  tracked,
  zoneChain,
  zonePlace,
} from './rules.ts';
import { occupancyZones } from './service.ts';
import { failed, readUnsigned, waiting, writeUnsigned } from './unsigned.ts';

export const DUE_BATCH = 200;
const CHUNK = 25;

type Verdict = { exit: OutCause } | { rearm: number | null };

/**
 * What a due row needs, from the zone as it is now. A zone that no longer tracks closes its rows
 * (`zone`). A due time from old settings is re-armed, not acted on, unless a zone save above the row
 * set it (a tap-out stamps its own save time as the due time).
 */
export function verdict(
  zones: readonly OccZone[],
  row: DueRow,
  now: number,
  orgTimeZone: string | null = null,
): Verdict | null {
  if (!row.scope.startsWith('zone:')) return null;
  const zone = zones.find((z) => zonePlace(z.id) === row.scope);
  if (!zone || !tracked(zone)) return { exit: 'zone' };
  const clock = effectiveTimeZone(indexZones(zones), zone.id, orgTimeZone);
  const due = dueAt(zone, row.entered_at, clock);
  if (due !== null && due <= now) {
    const stay = zone.maxStayMinutes == null ? null : row.entered_at + zone.maxStayMinutes * 60_000;
    const clear = zone.clearAt == null ? null : nextClear(zone.clearAt, row.entered_at, clock);
    return { exit: clear !== null && (stay === null || clear <= stay) ? 'clear' : 'stay' };
  }
  if (zoneChain(zones, zone.id).some((z) => z.updatedAt === row.due_at)) return { exit: 'zone' };
  return { rearm: due };
}

/** A grant refusal (stale row, suspended org) is a skip; anything else is a bug. */
const refusal = (error: unknown) => error instanceof AppError && error.status < 500;

/** A row that cannot be signed (or whose proof disagrees with it): skipped with a growing delay. */
const unsignable = (error: unknown) =>
  error instanceof InvalidScanRetentionProof ||
  (error instanceof AppError && error.code === 'SCAN_PROOF_MISMATCH');

/** A fetch full of failures is followed by another, so unsignable rows cannot starve the rest. */
const ROUNDS = 5;

export async function autoTapOut(ctx: ServiceContext, makeExit = exitGrant): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const memory = await readUnsigned(db);
  const skip = new Set(waiting(memory, now));
  const zones = new Map<string, OccZone[]>();
  const clocks = new Map<string, string | null>();
  const seen = new Set<string>();
  const tally = { due: 0, exits: 0, rearms: 0, refused: 0, unsigned: 0 };
  let dirty = false;
  for (let round = 0; round < ROUNDS; round++) {
    const rows = await dueRows(db, now, DUE_BATCH, [...skip]);
    if (rows.length === 0) break;
    tally.due += rows.length;
    const made: { row: DueRow; exit: boolean; make: () => Promise<Grant> }[] = [];
    for (const row of rows) {
      seen.add(stayKey(row));
      const org = zones.get(row.org_id) ?? (await occupancyZones(db, row.org_id));
      zones.set(row.org_id, org);
      if (!clocks.has(row.org_id)) clocks.set(row.org_id, await readOrgTimeZone(db, row.org_id));
      const v = verdict(org, row, now, clocks.get(row.org_id) ?? null);
      if (!v) continue;
      const list = org;
      if ('exit' in v) {
        tally.exits++;
        made.push({
          row,
          exit: true,
          make: () => makeExit(ctx, row, exitAsGiven(list, row.scope), v.exit, now),
        });
      } else {
        tally.rearms++;
        made.push({ row, exit: false, make: async () => rearmGrant(ctx, row, v.rearm) });
      }
    }
    let failures = 0;
    const done = (c: (typeof made)[number]) => {
      if (c.exit && memory.delete(stayKey(c.row))) dirty = true;
    };
    for (let at = 0; at < made.length; at += CHUNK) {
      const chunk = made.slice(at, at + CHUNK);
      try {
        await grantedBatch(db, await Promise.all(chunk.map((c) => c.make())));
        for (const c of chunk) done(c);
        continue;
      } catch (error) {
        if (!refusal(error) && !unsignable(error)) throw error;
      }
      for (const c of chunk)
        try {
          await (await c.make()).commit();
          done(c);
        } catch (error) {
          if (unsignable(error)) {
            const key = stayKey(c.row);
            const count = failed(memory, key, now);
            skip.add(key);
            dirty = true;
            failures++;
            tally.unsigned++;
            ctx.log.error('scan.occupancy_proof', {
              code: 'SCAN_OCCUPANCY_PROOF',
              orgId: c.row.org_id,
              failures: count,
            });
          } else if (refusal(error)) {
            tally.refused++;
            ctx.log.warn('scan.occupancy_skip', {
              code: 'SCAN_OCCUPANCY_REFUSED',
              orgId: c.row.org_id,
            });
          } else throw error;
        }
    }
    if (failures === 0 || rows.length < DUE_BATCH) break;
  }
  // A stay that is no longer due (tapped out, moved) leaves the memory once its delay has passed.
  for (const [key, u] of memory)
    if (u.retryAt <= now && !seen.has(key)) {
      memory.delete(key);
      dirty = true;
    }
  if (dirty) await writeUnsigned(db, memory, now);
  if (tally.due > 0) ctx.log.info('scan.occupancy', tally);
}
