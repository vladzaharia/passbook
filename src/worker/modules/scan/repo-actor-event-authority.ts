import type { SqlValue } from '../../platform/db.ts';
import { usableScanTemplateSql } from './repo-scope-releases.ts';

/*
 * Event and session parts of the actor predicate that stay column-based: the release proofs of an
 * event's templates (for operations that do not name the scanned template) and the snapshots of
 * console actors without captured epochs.
 */

/** The admin session as originally captured: lifetime equality, not only liveness. */
export function appendLegacyAdminSession(
  authority: {
    sessionId: string;
    userId: string;
    sessionCreatedAt: number;
    sessionExpiresAt: number;
  },
  parts: string[],
  params: SqlValue[],
): boolean {
  if (
    !Number.isSafeInteger(authority.sessionCreatedAt) ||
    !Number.isSafeInteger(authority.sessionExpiresAt) ||
    authority.sessionExpiresAt <= authority.sessionCreatedAt
  )
    return false;
  parts.push(`EXISTS (SELECT 1 FROM sessions actor_session
        WHERE actor_session.id_hash=?/* scan-ephemeral-session-id-hash */ AND actor_session.user_id=?
          AND actor_session.created_at=? AND actor_session.expires_at=?)`);
  params.push(
    authority.sessionId,
    authority.userId,
    authority.sessionCreatedAt,
    authority.sessionExpiresAt,
  );
  return true;
}

const EVENT_SCOPE = {
  templateIdSql: 't.id',
  orgIdSql: 'e.org_id',
  modeSql: 'e.mode',
  providerSql: "'apple'",
};

/** The release proof of every template of the event, over the `actor_event` rows selected by `filter`. */
function eventTemplateProofsSql(filter: string): string {
  return `COALESCE((WITH actor_event AS MATERIALIZED (
      SELECT e.* FROM scan_events e WHERE ${filter}
      ), actor_event_templates AS MATERIALIZED (
        SELECT et.event_id,t.id AS template_id,(${usableScanTemplateSql(EVENT_SCOPE)}) AS usable
        FROM actor_event e JOIN scan_event_templates et ON et.event_id=e.id
        LEFT JOIN templates t ON t.id=et.template_id
          AND (t.org_id=e.org_id OR t.org_id IS NULL) AND t.status!='deleted'
      )
      SELECT (SELECT COUNT(*) FROM scan_event_templates et WHERE et.event_id=e.id) BETWEEN 1 AND 20
        AND NOT EXISTS (SELECT 1 FROM actor_event_templates et WHERE et.event_id=e.id
          AND (et.template_id IS NULL OR NOT et.usable))
      FROM actor_event e),0)`;
}

/**
 * Every template of the event is released, for an operation that does not name the scanned
 * template. Once the caller passes it, only that template is checked (the final block of the actor
 * predicate) and this goes.
 */
export function appendEventTemplateProofs(
  eventId: string,
  orgId: string,
  mode: string,
  parts: string[],
  params: SqlValue[],
): void {
  parts.push(
    eventTemplateProofsSql(
      'e.id=?/* scan-ephemeral-event-id */ AND e.org_id=? AND e.mode=? AND e.archived_at IS NULL',
    ),
  );
  params.push(eventId, orgId, mode);
}

/** One event as originally captured: its configuration columns, never its stamp (a rename moves no epoch). */
export function appendLegacyEvent(
  e: {
    id: string;
    matchInput: string | null;
    matchValues: string | null;
    opensAt: number;
    closesAt: number;
    timeZone: string;
    capacity: number | null;
    reentry: boolean;
  },
  orgId: string,
  mode: string,
  parts: string[],
  params: SqlValue[],
): void {
  parts.push(
    eventTemplateProofsSql(`(e.id=?/* scan-ephemeral-event-id */ AND e.org_id=? AND e.mode=?
          AND e.archived_at IS NULL)
        AND (e.match_input IS ?/* scan-ephemeral-event-match-input */
          AND e.match_values IS ?/* scan-ephemeral-event-match-values */
          AND e.opens_at=? AND e.closes_at=?)
        AND (e.time_zone=?/* scan-ephemeral-event-time-zone */ AND e.capacity IS ? AND e.reentry=?)`),
  );
  params.push(
    e.id,
    orgId,
    mode,
    e.matchInput,
    e.matchValues,
    e.opensAt,
    e.closesAt,
    e.timeZone,
    e.capacity,
    e.reentry,
  );
}
