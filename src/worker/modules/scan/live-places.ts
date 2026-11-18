import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { LiveRecipient } from './live-auth.ts';
import type { LiveRingRow } from './live-ring.ts';
import { livePlaceEventStmt, livePlaceTotalsStmt } from './repo-live-places.ts';
import { scanReadAuthority } from './repo-read-authority.ts';

/** More places than a snapshot carries (`ScanLiveSnapshotSchema`). */
const MAX_PLACES = 64;

/**
 * The events a monitor's watch covers: the one it names, and the event of every row it receives.
 * A customer screen has no counts.
 */
export function watchedEvents(recipient: LiveRecipient, rows: readonly LiveRingRow[]): string[] {
  if (recipient.attachment.role !== 'monitor') return [];
  const ids = new Set<string>();
  if (recipient.watch.eventId) ids.add(recipient.watch.eventId);
  for (const { eventId } of rows) if (eventId) ids.add(eventId);
  return [...ids].slice(0, MAX_PLACES);
}

/**
 * In-now counts for a monitor, one per watched event that tracks entries and exits, read under the
 * monitor's own authority (nothing comes back when it fails). `rev` is the read time (`at`, when the
 * caller fixes it at the start of its request), so a later read always orders after an earlier one. Who is inside is never returned: counts only.
 */
export async function livePlaces(
  ctx: ServiceContext,
  recipient: LiveRecipient,
  rows: readonly LiveRingRow[],
  at?: number,
): Promise<ScanPlaceRev[]> {
  const out: ScanPlaceRev[] = [];
  const { actor } = recipient;
  for (const eventId of watchedEvents(recipient, rows)) {
    const rev = at ?? ctx.clock.now();
    const auth = scanReadAuthority(actor, { now: rev, read: { stafflessMonitor: true } });
    const event = await livePlaceEventStmt(
      ctx.env.DB,
      auth,
      actor.orgId,
      actor.mode,
      eventId,
    ).first<{ name: string; capacity: number | null; reentry: number }>();
    if (event?.reentry !== 1) continue;
    const totals = await livePlaceTotalsStmt(ctx.env.DB, actor.orgId, actor.mode, eventId).first<{
      inside: number | null;
    }>();
    out.push({
      place: `event:${eventId}`,
      name: event.name.slice(0, 80),
      inNow: totals?.inside ?? 0,
      capacity: event.capacity,
      rev,
    });
  }
  return out;
}
