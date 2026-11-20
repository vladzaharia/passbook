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

/** The live session Scan passes made for the template, whatever it admits now. */
export const setupSession = (db: D1Database, orgId: string, mode: Mode, templateId: string) =>
  first<{ id: string }>(
    db,
    `SELECT id FROM scanning_sessions
     WHERE org_id = ? AND mode = ? AND setup_template_id = ? AND status <> 'ended'`,
    [orgId, mode, templateId],
  );

const LIVE = `p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.status = 'active'
  AND p.deleted_at IS NULL AND p.removed_at IS NULL AND p.test_data_quarantined = 0`;
/** Rows read per source; one more than this means there were more. */
export const MAX_ROWS = 500;
/** Passes read per call, newest first (ids are time-ordered); one more than this means older ones were left out. */
export const MAX_PASSES = 5000;
const path = (input: string | null) => (input ? `$.${input}` : null);
const iso = (ms: number) => new Date(ms).toISOString();
/** The newest live passes of the template: every read below works from these, never from all of them. */
const recent = (limit: number) =>
  `recent AS (SELECT p.personalization FROM passes p WHERE ${LIVE} ORDER BY p.id DESC LIMIT ${limit})`;

export interface EventRows {
  values: EventValues[];
  /** More rows matched than were read, or older passes were left out. */
  more: boolean;
  /** Distinct start values that are not ISO-8601 dates: their events are skipped. */
  unparsed: number;
}

/**
 * The distinct events the template's newest issued, unvoided passes name in their own inputs, soonest
 * first. `since` leaves out events that started long before (the plan drops ended ones exactly).
 */
export async function ownEventValues(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  own: NonNullable<EventSource['own']>,
  since: number,
  limit = MAX_PASSES,
): Promise<EventRows> {
  const scope = [orgId, mode, templateId];
  const [rows, stats] = await Promise.all([
    all<Record<string, string | null>>(
      db,
      `WITH ${recent(limit)}
       SELECT DISTINCT json_extract(p.personalization, ?) AS name, json_extract(p.personalization, ?) AS startsAt,
         json_extract(p.personalization, ?) AS endsAt, json_extract(p.personalization, ?) AS doorsAt,
         json_extract(p.personalization, ?) AS venueName, json_extract(p.personalization, ?) AS venueRegion,
         json_extract(p.personalization, ?) AS timeZone, json_extract(p.personalization, ?) AS slot,
         julianday(json_extract(p.personalization, ?)) AS startJ
       FROM recent p WHERE startJ >= julianday(?)
       ORDER BY startJ, name, venueName IS NULL, endsAt IS NULL, doorsAt IS NULL, venueName, endsAt, doorsAt
       LIMIT ${MAX_ROWS + 1}`,
      [
        ...scope,
        path(own.name),
        path(own.start),
        path(own.end),
        path(own.doors),
        path(own.venueName),
        path(own.venueRegion),
        path(own.zone),
        path(own.slot),
        path(own.start),
        iso(since),
      ],
    ),
    first<Stats>(
      db,
      `WITH ${recent(limit + 1)}
       SELECT count(*) AS scanned,
         count(DISTINCT CASE WHEN s IS NOT NULL AND julianday(s) IS NULL THEN s END) AS unparsed
       FROM (SELECT json_extract(personalization, ?) AS s FROM recent)`,
      [...scope, path(own.start)],
    ),
  ]);
  return {
    values: rows.slice(0, MAX_ROWS).map((row) => ({ ...row, own: true })),
    more: rows.length > MAX_ROWS || (stats?.scanned ?? 0) > limit,
    unparsed: stats?.unparsed ?? 0,
  };
}

interface Stats {
  scanned: number;
  unparsed: number;
}

/** The distinct object entries of the upcoming-events list on those passes, soonest first. */
export async function listedEventValues(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  list: string,
  since: number,
  limit = MAX_PASSES,
): Promise<EventRows> {
  const scope = [orgId, mode, templateId];
  const entries = `FROM recent p, json_each(CASE WHEN json_type(p.personalization, ?) = 'array'
       THEN json_extract(p.personalization, ?) ELSE '[]' END) j WHERE j.type = 'object'`;
  const [rows, stats] = await Promise.all([
    all<{ item: string }>(
      db,
      `WITH ${recent(limit)}
       SELECT DISTINCT j.value AS item, julianday(json_extract(j.value, '$.startsAt')) AS startJ
       ${entries} AND startJ >= julianday(?)
       ORDER BY startJ, item LIMIT ${MAX_ROWS + 1}`,
      [...scope, path(list), path(list), iso(since)],
    ),
    first<Stats>(
      db,
      `WITH ${recent(limit + 1)}
       SELECT (SELECT count(*) FROM recent) AS scanned,
         count(DISTINCT CASE WHEN json_extract(j.value, '$.startsAt') IS NOT NULL
           AND julianday(json_extract(j.value, '$.startsAt')) IS NULL
           THEN json_extract(j.value, '$.startsAt') END) AS unparsed
       ${entries}`,
      [...scope, path(list), path(list)],
    ),
  ]);
  // Only object entries are read, so every value is JSON text of an object.
  return {
    values: rows.slice(0, MAX_ROWS).map(({ item }) => JSON.parse(item) as EventValues),
    more: rows.length > MAX_ROWS || (stats?.scanned ?? 0) > limit,
    unparsed: stats?.unparsed ?? 0,
  };
}
