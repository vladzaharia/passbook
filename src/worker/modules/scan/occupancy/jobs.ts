// Minute cron `scan.occupancy` (SA §20.8): taps out passes whose Max stay or Clear at has passed, and
// those inside a zone that stopped tracking, was archived or moved. 200 rows a run, 25 grants a batch.
import { type Grant, grantedBatch } from '../../../platform/authority.ts';
import { AppError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { InvalidScanRetentionProof } from '../scan-retention-proof.ts';
import { effectiveTimeZone, indexZones } from '../zones-tree.ts';
import { exitGrant, type OutCause, rearmGrant } from './auto-exit.ts';
import { type DueRow, dueRows } from './repo-reads.ts';
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

export const DUE_BATCH = 200;
const CHUNK = 25;

type Verdict = { exit: OutCause } | { rearm: number | null };

/**
 * What a due row needs, from the zone as it is now. A zone that no longer tracks closes its rows
 * (`zone`). A due time from old settings is re-armed, not acted on, unless a zone save above the row
 * set it (a tap-out stamps its own save time as the due time).
 */
export function verdict(zones: readonly OccZone[], row: DueRow, now: number): Verdict | null {
  if (!row.scope.startsWith('zone:')) return null;
  const zone = zones.find((z) => zonePlace(z.id) === row.scope);
  if (!zone || !tracked(zone)) return { exit: 'zone' };
  const clock = effectiveTimeZone(indexZones(zones), zone.id);
  const due = dueAt(zone, row.entered_at, clock);
  if (due !== null && due <= now) {
    const stay = zone.maxStayMinutes == null ? null : row.entered_at + zone.maxStayMinutes * 60_000;
    const clear = zone.clearAt == null ? null : nextClear(zone.clearAt, row.entered_at, clock);
    return { exit: clear !== null && (stay === null || clear <= stay) ? 'clear' : 'stay' };
  }
  if (zoneChain(zones, zone.id).some((z) => z.updatedAt === row.due_at)) return { exit: 'zone' };
  return { rearm: due };
}

/** A grant refusal (stale row, suspended org) or an unsignable row is a skip; anything else is a bug. */
const refusal = (error: unknown) =>
  (error instanceof AppError && error.status < 500) || error instanceof InvalidScanRetentionProof;

export async function autoTapOut(ctx: ServiceContext): Promise<void> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const rows = await dueRows(db, now, DUE_BATCH);
  if (rows.length === 0) return;
  const zones = new Map<string, OccZone[]>();
  const made: { row: DueRow; make: () => Promise<Grant> }[] = [];
  let exits = 0;
  let rearms = 0;
  for (const row of rows) {
    const org = zones.get(row.org_id) ?? (await occupancyZones(db, row.org_id));
    zones.set(row.org_id, org);
    const v = verdict(org, row, now);
    if (!v) continue;
    const list = org;
    if ('exit' in v) {
      exits++;
      made.push({
        row,
        make: () => exitGrant(ctx, row, exitAsGiven(list, row.scope), v.exit, now),
      });
    } else {
      rearms++;
      made.push({ row, make: async () => rearmGrant(ctx, row, v.rearm) });
    }
  }
  let refused = 0;
  for (let at = 0; at < made.length; at += CHUNK) {
    const chunk = made.slice(at, at + CHUNK);
    try {
      await grantedBatch(db, await Promise.all(chunk.map((c) => c.make())));
      continue;
    } catch (error) {
      if (!refusal(error)) throw error;
    }
    for (const c of chunk)
      try {
        await (await c.make()).commit();
      } catch (error) {
        if (!refusal(error)) throw error;
        refused++;
        if (error instanceof InvalidScanRetentionProof)
          ctx.log.error('scan.occupancy_proof', {
            code: 'SCAN_OCCUPANCY_PROOF',
            orgId: c.row.org_id,
          });
        else
          ctx.log.warn('scan.occupancy_skip', {
            code: 'SCAN_OCCUPANCY_REFUSED',
            orgId: c.row.org_id,
          });
      }
  }
  ctx.log.info('scan.occupancy', { due: rows.length, exits, rearms, refused });
}
