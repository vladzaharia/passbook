import type { Channel, TemplateChannelState } from '../../../shared/contracts/channels.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { all, chunk, first, placeholders } from '../../platform/db.ts';
import { rolesGranting } from '../orgs/access.ts';

/** The manifest of a template version, as stored. */
export async function manifestOf(
  db: D1Database,
  templateId: string,
  version: string | null,
): Promise<string | null> {
  if (!version) return null;
  const r = await first<{ manifest: string }>(
    db,
    'SELECT manifest FROM template_versions WHERE template_id = ? AND version = ?',
    [templateId, version],
  );
  return r?.manifest ?? null;
}

export interface EventRow {
  id: string;
  name: string;
  opens_at: number;
  closes_at: number;
}

/** Live events of the template that are open now or open before `until`. */
export async function eventsOf(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  now: number,
  until: number,
): Promise<EventRow[]> {
  return all<EventRow>(
    db,
    `SELECT e.id, e.name, e.opens_at, e.closes_at FROM scan_events e
     JOIN scan_event_templates t ON t.event_id = e.id AND t.template_id = ?
     WHERE e.org_id = ? AND e.mode = ? AND e.archived_at IS NULL AND e.closes_at > ? AND e.opens_at < ?
     ORDER BY e.opens_at`,
    [templateId, orgId, mode, now, until],
  );
}

/** Every event of the template, live or not: a session bound to one of them admits the template. */
export async function eventIdsOf(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
): Promise<string[]> {
  const rows = await all<{ event_id: string }>(
    db,
    `SELECT t.event_id FROM scan_event_templates t JOIN scan_events e ON e.id = t.event_id
     WHERE t.template_id = ? AND e.org_id = ? AND e.mode = ?`,
    [templateId, orgId, mode],
  );
  return rows.map((r) => r.event_id);
}

export interface SessionRow {
  id: string;
  name: string;
  accepts: string | null;
  time_zone: string;
  hours: string | null;
  hold: string | null;
}

export async function activeSessions(
  db: D1Database,
  orgId: string,
  mode: Mode,
): Promise<SessionRow[]> {
  return all<SessionRow>(
    db,
    `SELECT id, name, accepts, time_zone, hours, hold FROM scanning_sessions
     WHERE org_id = ? AND mode = ? AND status = 'active'`,
    [orgId, mode],
  );
}

/**
 * Active passes of the template with a copy in the channel that the save leaves off: an override off,
 * or no override while the new state is not on (never clears overrides).
 */
export async function rotatedCount(
  db: D1Database,
  orgId: string,
  mode: Mode,
  templateId: string,
  channel: Channel,
  next: TemplateChannelState,
): Promise<number> {
  const r = await first<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT p.id) AS n FROM passes p
     JOIN pass_channel_copies c ON c.pass_id = p.id AND c.channel = ?
     LEFT JOIN pass_channels pc ON pc.pass_id = p.id AND pc.channel = ?
     WHERE p.org_id = ? AND p.mode = ? AND p.template_id = ? AND p.deleted_at IS NULL
       AND p.removed_at IS NULL AND p.status = 'active'
       AND (? = 'never' OR pc.override = 'off' OR (pc.override IS NULL AND ? <> 'on'))`,
    [channel, channel, orgId, mode, templateId, next, next],
  );
  return r?.n ?? 0;
}

/** Whether a rotation by this actor id is already recorded for the pass (a retried page). */
export async function rotatedBy(db: D1Database, passId: string, actorId: string): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 AS hit FROM scan_code_rotations WHERE pass_id = ? AND actor_id = ? LIMIT 1',
      [passId, actorId],
    )) !== null
  );
}

/** Marks of the run that still owe the holder their notice. */
export async function unnoticed(
  db: D1Database,
  runId: string,
  passIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunk([...passIds])) {
    const rows = await all<{ pass_id: string }>(
      db,
      `SELECT pass_id FROM channel_apply_marks
       WHERE run_id = ? AND notice_at IS NULL AND pass_id IN (${placeholders(ids.length)})`,
      [runId, ...ids],
    );
    for (const r of rows) out.add(r.pass_id);
  }
  return out;
}

/** The requester still holds the right to publish templates: an active member of the org or an admin. */
export async function mayPublish(db: D1Database, orgId: string, userId: string): Promise<boolean> {
  const r = await first(
    db,
    `SELECT 1 AS ok FROM users u WHERE u.id = ? AND u.status = 'active' AND (
       EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = u.id AND m.org_id = ?
         AND m.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(m.roles) r JOIN json_each(?) g ON g.value = r.value
           WHERE r.type = 'text'))
       OR (json_valid(u.last_roles)
         AND EXISTS (SELECT 1 FROM json_each(u.last_roles) r WHERE r.type = 'text' AND r.value = 'admin')))`,
    [userId, orgId, JSON.stringify(rolesGranting('templates:publish'))],
  );
  return r !== null;
}
