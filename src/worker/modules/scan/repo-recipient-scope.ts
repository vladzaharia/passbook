import type { SqlValue } from '../../platform/db.ts';
import type { ScanActor } from './actor.ts';
import { eventMatchSql } from './repo-event-match.ts';

/**
 * Whether the actor's scope accepts the pass in `alias` (a trusted `passes` alias): the template and
 * event rules `scanActorChecks` applies to one named template, as a predicate over rows. Null when
 * the scope accepts nothing. The actor's own epochs and tenant come from its read authority.
 */
export function actorPassScopeSql(
  actor: ScanActor,
  alias: string,
): { sql: string; params: SqlValue[] } | null {
  if (actor.invalidScannerScope) return null;
  if (actor.scanningSession && actor.scanningSession.status !== 'active') return null;
  if (actor.scanner?.eventId && !actor.scanningSession && !actor.event) return null;
  const parts: string[] = [];
  const params: SqlValue[] = [];
  const scoped =
    actor.scanner?.deviceRole === 'scan' ||
    !!actor.scanningSession ||
    !!actor.event ||
    actor.templateIds.length > 0;
  if (scoped) {
    if (actor.templateIds.length === 0) {
      if (actor.settings.acceptAllTemplates !== true) return null;
    } else if (actor.event) {
      parts.push(`EXISTS (SELECT 1 FROM scan_event_templates sc_et
        WHERE sc_et.event_id = ? AND sc_et.template_id = ${alias}.template_id)`);
      params.push(actor.event.id);
    } else if (actor.events && actor.scanningSession) {
      // A mixed session: a template entry, or a live event of it whose filter takes the pass.
      parts.push(`EXISTS (SELECT 1 FROM scanning_sessions sc_ss WHERE sc_ss.id = ? AND (
        EXISTS (SELECT 1 FROM json_each(sc_ss.accepts, '$.templateIds') sc_j
          WHERE sc_j.value = ${alias}.template_id)
        OR EXISTS (SELECT 1 FROM json_each(sc_ss.accepts, '$.eventIds') sc_je
          JOIN scan_events sc_e ON sc_e.id = sc_je.value AND sc_e.org_id = sc_ss.org_id
            AND sc_e.mode = sc_ss.mode AND sc_e.archived_at IS NULL
          JOIN scan_event_templates sc_et ON sc_et.event_id = sc_e.id
            AND sc_et.template_id = ${alias}.template_id
          WHERE ${eventMatchSql('sc_e', alias)})))`);
      params.push(actor.scanningSession.id);
    } else if (actor.scanningSession) {
      parts.push(`EXISTS (SELECT 1 FROM scanning_sessions sc_ss, json_each(sc_ss.accepts, '$.templateIds') sc_j
        WHERE sc_ss.id = ? AND sc_j.value = ${alias}.template_id)`);
      params.push(actor.scanningSession.id);
    } else if (actor.scanner) {
      parts.push(`EXISTS (SELECT 1 FROM scanner_templates sc_st
        WHERE sc_st.scanner_id = ? AND sc_st.template_id = ${alias}.template_id)`);
      params.push(actor.scanner.id);
    } else if (actor.principal === 'admin') {
      // An admin's templates are the request's own, validated by the guard: no stored scope to read.
      parts.push(`${alias}.template_id IN (SELECT value FROM json_each(?) WHERE type = 'text')`);
      params.push(JSON.stringify(actor.templateIds));
    } else return null;
  }
  if (actor.event) {
    parts.push(`EXISTS (SELECT 1 FROM scan_events sc_e WHERE sc_e.id = ? AND sc_e.archived_at IS NULL
      AND ${eventMatchSql('sc_e', alias)})`);
    params.push(actor.event.id);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1', params };
}
