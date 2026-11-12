import type { Grant } from '../../platform/authority.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all, type SqlValue } from '../../platform/db.ts';

/** `inList` takes at most 20 values per statement. */
const CHUNK = 20;

/**
 * Events whose expected-count cache a new release of the template invalidates: events of the release's
 * org (all orgs, for a platform release) and mode that select the template.
 */
export async function eventIdsForRelease(
  db: D1Database,
  templateId: string,
  mode: string,
  orgId: string | null,
): Promise<string[]> {
  const params: SqlValue[] = [templateId, mode];
  if (orgId !== null) params.push(orgId);
  const rows = await all<{ id: string }>(
    db,
    `SELECT DISTINCT e.id FROM scan_events e
     JOIN scan_event_templates s ON s.event_id = e.id
     WHERE s.template_id = ? AND e.mode = ?${orgId === null ? '' : ' AND e.org_id = ?'}`,
    params,
  );
  return rows.map((r) => r.id);
}

/** Clears the cached expected count of the events, in the grant's batch. */
export function invalidateEventCache(g: Grant, eventIds: readonly string[], mode: string): void {
  for (let i = 0; i < eventIds.length; i += CHUNK)
    g.update('scan_events', {
      set: { expected: null, expected_at: null },
      where: { id: inList(eventIds.slice(i, i + CHUNK)), mode },
    });
}
