import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import type { EventSource, EventValues } from './template-setup-plan.ts';

/**
 * The newest live session (active or paused) that names the template or an open event of it. A
 * session that admits every pass type is not a setup for this template, so it never matches.
 */
export const sessionScanningTemplate = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
) =>
  first<{ id: string }>(
    db,
    `SELECT s.id FROM scanning_sessions s
     WHERE s.org_id = ? AND s.mode = ? AND s.status IN ('active', 'paused') AND s.accepts IS NOT NULL
       AND (EXISTS (SELECT 1 FROM json_each(json_extract(s.accepts, '$.templateIds')) j WHERE j.value = ?)
         OR EXISTS (SELECT 1 FROM json_each(json_extract(s.accepts, '$.eventIds')) j
              JOIN scan_events e ON e.id = j.value AND e.org_id = s.org_id AND e.archived_at IS NULL
              JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?)
         OR EXISTS (SELECT 1 FROM scan_events e
              JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?
              WHERE e.id = json_extract(s.accepts, '$.eventId') AND e.org_id = s.org_id AND e.archived_at IS NULL))
     ORDER BY (s.setup_template_id IS NOT NULL) DESC, s.created_at DESC, s.id LIMIT 1`,
    [orgId, mode, templateId, templateId, templateId],
  );

/** The live event Scan passes made for this key. */
export const setupEvent = (db: D1Database, orgId: string, mode: Mode, key: string) =>
  first<{ id: string }>(
    db,
    `SELECT id FROM scan_events
     WHERE org_id = ? AND mode = ? AND setup_key = ? AND archived_at IS NULL`,
    [orgId, mode, key],
  );

const LIVE = `p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.status = 'active'
  AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0`;
const MAX_ROWS = 500;
const path = (input: string | null) => (input ? `$.${input}` : null);

/** The distinct events the template's issued, unvoided passes name in their own inputs. */
export async function ownEventValues(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  own: NonNullable<EventSource['own']>,
): Promise<EventValues[]> {
  const rows = await all<Record<string, string | null>>(
    db,
    `SELECT DISTINCT json_extract(p.personalization, ?) AS name, json_extract(p.personalization, ?) AS startsAt,
       json_extract(p.personalization, ?) AS endsAt, json_extract(p.personalization, ?) AS doorsAt,
       json_extract(p.personalization, ?) AS venueName, json_extract(p.personalization, ?) AS venueRegion,
       json_extract(p.personalization, ?) AS timeZone
     FROM passes p WHERE ${LIVE} LIMIT ${MAX_ROWS}`,
    [
      path(own.name),
      path(own.start),
      path(own.end),
      path(own.doors),
      path(own.venueName),
      path(own.venueRegion),
      path(own.zone),
      orgId,
      mode,
      templateId,
    ],
  );
  return rows.map((row) => ({ ...row, own: true }));
}

/** The distinct entries of the upcoming-events list on those passes. */
export async function listedEventValues(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  list: string,
): Promise<EventValues[]> {
  const rows = await all<{ item: string }>(
    db,
    `SELECT DISTINCT j.value AS item
     FROM passes p, json_each(CASE WHEN json_type(p.personalization, ?) = 'array'
       THEN json_extract(p.personalization, ?) ELSE '[]' END) j
     WHERE ${LIVE} LIMIT ${MAX_ROWS}`,
    [path(list), path(list), orgId, mode, templateId],
  );
  // json_each yields valid JSON text; only an object is an event.
  return rows.flatMap(({ item }) => {
    const value = JSON.parse(item) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? [value as EventValues]
      : [];
  });
}
