import { all, first } from '../../platform/db.ts';

export interface PassDevice {
  shortId: string;
  createdAt: number;
  lastPush: { state: string; at: number } | null;
}

/**
 * Registered devices, newest first, each with the newest push created after it registered. The
 * device library id stays server-side; six characters are enough to tell devices apart.
 */
export async function listPassDevices(db: D1Database, passId: string): Promise<PassDevice[]> {
  const rows = await all<{
    device_id: string;
    created_at: number;
    push_state: string | null;
    push_at: number | null;
  }>(
    db,
    `SELECT r.device_id, r.created_at, o.state AS push_state,
       COALESCE(o.finished_at, o.created_at) AS push_at
     FROM registrations r
     LEFT JOIN outbox o ON o.id = (
       SELECT id FROM outbox WHERE pass_id = r.pass_id AND kind = 'push' AND created_at >= r.created_at
       ORDER BY created_at DESC, id DESC LIMIT 1)
     WHERE r.pass_id = ? ORDER BY r.created_at DESC`,
    [passId],
  );
  return rows.map((r) => ({
    shortId: r.device_id.slice(-6),
    createdAt: r.created_at,
    lastPush: r.push_state && r.push_at !== null ? { state: r.push_state, at: r.push_at } : null,
  }));
}

/** The newest void of a pass in the audit log, with the actor's display name. */
export async function lastVoidEvent(
  db: D1Database,
  passId: string,
): Promise<{ at: number; actorType: string; actorLabel: string | null } | null> {
  const row = await first<{ at: number; actor_type: string; label: string | null }>(
    db,
    `SELECT a.at, a.actor_type,
       CASE a.actor_type
         WHEN 'user' THEN (SELECT COALESCE(name, primary_email) FROM users WHERE id = a.actor_id)
         WHEN 'api_key' THEN (SELECT name FROM api_keys WHERE id = a.actor_id)
         WHEN 'connection' THEN (SELECT name FROM connections WHERE id = a.actor_id)
       END AS label
     FROM audit_log a
     WHERE a.target_type = 'pass' AND a.target_id = ? AND a.action = 'pass.void'
     ORDER BY a.at DESC, a.id DESC LIMIT 1`,
    [passId],
  );
  return row ? { at: row.at, actorType: row.actor_type, actorLabel: row.label } : null;
}
