import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';

const KEY_PREFIX = 'scan-setup:';
const REQUEST = 'scan-setup';

/**
 * The newest active session that names the template or an open event of it. A session that admits
 * every pass type is not a setup for this template, so it never matches.
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
     WHERE s.org_id = ? AND s.mode = ? AND s.status = 'active' AND s.accepts IS NOT NULL
       AND (EXISTS (SELECT 1 FROM json_each(json_extract(s.accepts, '$.templateIds')) j WHERE j.value = ?)
         OR EXISTS (SELECT 1 FROM json_each(json_extract(s.accepts, '$.eventIds')) j
              JOIN scan_events e ON e.id = j.value AND e.org_id = s.org_id AND e.archived_at IS NULL
              JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?)
         OR EXISTS (SELECT 1 FROM scan_events e
              JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?
              WHERE e.id = json_extract(s.accepts, '$.eventId') AND e.org_id = s.org_id AND e.archived_at IS NULL))
     ORDER BY s.created_at DESC, s.id LIMIT 1`,
    [orgId, mode, templateId, templateId, templateId],
  );

/** A live event of the template with this name and window, left by an earlier call that did not finish. */
export const eventLike = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  name: string,
  opensAt: number,
  closesAt: number,
) =>
  first<{ id: string }>(
    db,
    `SELECT e.id FROM scan_events e
     JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?
     WHERE e.org_id = ? AND e.mode = ? AND e.name = ? AND e.opens_at = ? AND e.closes_at = ?
       AND e.archived_at IS NULL
     ORDER BY e.created_at, e.id LIMIT 1`,
    [templateId, orgId, mode, name, opensAt, closesAt],
  );

export const eventNames = (db: D1Database, orgId: string, ids: readonly string[]) =>
  all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM scan_events WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [orgId, ...ids],
  );

const keyOf = (mode: Mode, templateId: string) => `${KEY_PREFIX}${mode}:${templateId}`;

/** Only one call per template and mode builds a setup at a time; the key is a lock, not a record. */
export async function claimSetup(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  reservation: string,
  now: number,
): Promise<boolean> {
  const done = await run(
    db,
    `INSERT OR IGNORE INTO idempotency_keys (org_id, key, request_hash, resource_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, keyOf(mode, templateId), REQUEST, reservation, now],
  );
  return done.changes === 1;
}

export const releaseSetup = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  reservation: string,
) =>
  run(db, 'DELETE FROM idempotency_keys WHERE org_id = ? AND key = ? AND resource_id = ?', [
    orgId,
    keyOf(mode, templateId),
    reservation,
  ]);

/** Frees a lock whose holder died: the same reservation, older than `before`. */
export const reclaimSetup = (
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  before: number,
) =>
  run(db, 'DELETE FROM idempotency_keys WHERE org_id = ? AND key = ? AND created_at < ?', [
    orgId,
    keyOf(mode, templateId),
    before,
  ]);
