import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { scanEpochsOf } from './scan-epochs.ts';

/** Add the observed event to a session read fence: live now, at the epoch the actor captured. */
export function appendSessionReadEventPredicate(
  actor: ScanActor,
  _scanner: ScanActor['scanner'],
  scopeRedacted: boolean,
  parts: string[],
  params: SqlValue[],
): boolean {
  const event = actor.event;
  if (event && !scopeRedacted) {
    if (event.orgId !== actor.orgId || event.mode !== actor.mode || event.archivedAt !== null)
      return false;
    // Match rule, window, capacity, time zone and the template list all move the event's config
    // epoch; name, note and updated_at are labels that a rename may change under a read.
    const epoch = scanEpochsOf(actor)?.events[event.id];
    if (epoch === undefined) return false;
    parts.push(`EXISTS (SELECT 1 FROM scan_events e WHERE e.id=?/* scan-ephemeral-event-id */
      AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL AND e.config_epoch=?)`);
    params.push(event.id, event.orgId, event.mode, epoch);
  }
  return true;
}
