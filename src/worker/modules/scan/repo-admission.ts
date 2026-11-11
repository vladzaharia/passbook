import { first, stmt } from '../../platform/db.ts';
import type { AdmissionHistory, PresenceRow } from './admission-types.ts';
import type { ScanEventRow } from './repo-scope.ts';

/** A configured but absent event uses the same unscoped admission history as before. */
const selectedEventSql = `CASE WHEN ?=1 THEN ?/* scan-ephemeral-event-id */
  ELSE (SELECT id FROM scan_events WHERE id=?/* scan-ephemeral-event-id */ AND org_id=?) END`;

function historyStmt(
  db: D1Database,
  orgId: string,
  passId: string,
  eventId: string | null,
  knownEvent: boolean,
) {
  return stmt(
    db,
    `WITH selected_event(id) AS (SELECT ${selectedEventSql}),
    entries AS (SELECT at FROM scans
      WHERE org_id=? AND pass_id=?/* scan-ephemeral-pass-id */
        AND ((SELECT id FROM selected_event) IS NULL OR event_id=(SELECT id FROM selected_event))
        AND outcome='ok' AND action_kind='check_in' AND (direction IS NULL OR direction='in') AND undone_by IS NULL
      UNION ALL SELECT last_at FROM scan_gates WHERE org_id=? AND pass_id=?/* scan-ephemeral-pass-id */
        AND ((SELECT id FROM selected_event) IS NULL OR scope='event:'||(SELECT id FROM selected_event))
        AND kind='check_in' AND state IN ('in','out'))
    SELECT MIN(at) AS first_at,MAX(at) AS last_at FROM entries`,
    [knownEvent ? 1 : 0, eventId, eventId, orgId, orgId, passId, orgId, passId],
  );
}

export const presenceOf = (db: D1Database, orgId: string, passId: string, scope: string) =>
  first<PresenceRow>(
    db,
    'SELECT * FROM scan_presence WHERE org_id=? AND pass_id=?/* scan-ephemeral-pass-id */ AND scope=?/* scan-ephemeral-event-scope */',
    [orgId, passId, scope],
  );

export async function admissionReads(
  db: D1Database,
  orgId: string,
  passId: string,
  eventId: string | null,
  knownEvent: ScanEventRow | null,
  additional: readonly D1PreparedStatement[] = [],
) {
  const needsEventRead = !!eventId && !knownEvent;
  const results = await db.batch([
    historyStmt(db, orgId, passId, eventId, !!knownEvent),
    stmt(
      db,
      `WITH selected_event(id) AS (SELECT ${selectedEventSql})
      SELECT * FROM scan_presence WHERE org_id=? AND pass_id=?/* scan-ephemeral-pass-id */
        AND scope=COALESCE('event:'||(SELECT id FROM selected_event),'')`,
      [knownEvent ? 1 : 0, eventId, eventId, orgId, orgId, passId],
    ),
    ...(needsEventRead
      ? [
          stmt(
            db,
            `SELECT id,org_id AS orgId,mode,name,match_input AS matchInput,
      match_values AS matchValues,opens_at AS opensAt,closes_at AS closesAt,time_zone AS timeZone,
      capacity,reentry,note,updated_at AS updatedAt,archived_at AS archivedAt
      FROM scan_events WHERE id=?/* scan-ephemeral-event-id */ AND org_id=?`,
            [eventId, orgId],
          ),
        ]
      : []),
    ...additional,
  ]);
  const rawEvent = needsEventRead
    ? (results[2]?.results?.[0] as
        | (Omit<ScanEventRow, 'reentry'> & { reentry: number })
        | undefined)
    : undefined;
  return {
    history: (results[0]?.results[0] ?? null) as Omit<AdmissionHistory, 'today_at'> | null,
    presence: (results[1]?.results[0] ?? null) as PresenceRow | null,
    event: knownEvent ?? (rawEvent ? { ...rawEvent, reentry: rawEvent.reentry === 1 } : null),
    additional: results.slice(needsEventRead ? 3 : 2),
  };
}
