import { all, first } from '../../platform/db.ts';

const HOUR = 3_600_000;

export interface HomeSandboxRow {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  created_at: number;
  closed_at: number | null;
  close_reason: 'idle' | 'admin' | 'user' | null;
  purge_after: number | null;
  quickstart_viewed_at: number | null;
  track_started_at: number | null;
  track_key_call_at: number | null;
  track_pass_at: number | null;
  track_change_at: number | null;
  track_webhook_at: number | null;
}

/** The person's sandbox with its org and track. The only lookup the home makes by person; the rest is by this org. */
export const homeSandboxOf = (db: D1Database, userId: string) =>
  first<HomeSandboxRow>(
    db,
    `SELECT d.id, d.org_id, o.slug, o.name, d.created_at, d.closed_at, d.close_reason, o.purge_after,
       d.quickstart_viewed_at, d.track_started_at, d.track_key_call_at, d.track_pass_at, d.track_change_at,
       d.track_webhook_at
     FROM developer_sandboxes d JOIN orgs o ON o.id = d.org_id WHERE d.user_id = ?`,
    [userId],
  );

/** Calls and errors per clock hour since `since`, keyed by `at / 1h`. */
export const callHours = (db: D1Database, orgId: string, since: number) =>
  all<{ hour: number; calls: number; errors: number }>(
    db,
    `SELECT at / ${HOUR} AS hour, COUNT(*) AS calls, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
     FROM request_log WHERE org_id = ? AND at >= ? GROUP BY hour`,
    [orgId, since],
  );

export const capturesSince = async (db: D1Database, orgId: string, since: number) =>
  (
    await first<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM webhook_captures WHERE org_id = ? AND created_at >= ?',
      [orgId, since],
    )
  )?.n ?? 0;

/** Test passes held, counted as the pass limit counts them (repo-create-checks.ts `passLimit`). */
export const testPassCount = async (db: D1Database, orgId: string) =>
  (
    await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND mode = 'test'
       AND removed_at IS NULL AND deleted_at IS NULL AND test_data_quarantined = 0`,
      [orgId],
    )
  )?.n ?? 0;

export interface HomePassRow {
  id: string;
  template_id: string;
  display_title: string | null;
  display_subtitle: string | null;
  status: 'active' | 'voided';
  version: number;
  created_at: number;
  modified_at: number;
  link_generation: number;
}

export const latestTestPasses = (db: D1Database, orgId: string, limit: number) =>
  all<HomePassRow>(
    db,
    `SELECT id, template_id, display_title, display_subtitle, status, version, created_at, modified_at, link_generation
     FROM passes WHERE org_id = ? AND mode = 'test'
       AND removed_at IS NULL AND deleted_at IS NULL AND test_data_quarantined = 0
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [orgId, limit],
  );

export interface HomeKeyRow {
  id: string;
  name: string;
  prefix: string;
  secret_label: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  retire_at: number | null;
}

/** The org's keys that still work or can be rolled: not revoked, not past a roll's overlap. Expired ones stay. */
export const openKeysOf = (db: D1Database, orgId: string, now: number) =>
  all<HomeKeyRow>(
    db,
    `SELECT id, name, prefix, secret_label, scopes, created_at, expires_at, last_used_at, retire_at
     FROM api_keys WHERE org_id = ? AND revoked_at IS NULL AND (retire_at IS NULL OR retire_at > ?)
     ORDER BY created_at DESC, id DESC`,
    [orgId, now],
  );

export interface HomeEndpointRow {
  id: string;
  target: 'capture' | 'url';
  url: string;
  status: 'active' | 'paused' | 'disabled';
  event_types: string;
  last_success_at: number | null;
  last_failure_at: number | null;
  capture_at: number | null;
  capture_status: number | null;
}

/** Test endpoints, the capture first, each with its last capture. */
export const endpointsOf = (db: D1Database, orgId: string) =>
  all<HomeEndpointRow>(
    db,
    `SELECT e.id, e.target, e.url, e.status, e.event_types, e.last_success_at, e.last_failure_at,
       c.created_at AS capture_at, c.status AS capture_status
     FROM webhook_endpoints e
     LEFT JOIN webhook_captures c ON c.id = (
       SELECT x.id FROM webhook_captures x WHERE x.endpoint_id = e.id AND x.org_id = e.org_id
       ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
     WHERE e.org_id = ? AND e.mode = 'test'
     ORDER BY e.target = 'capture' DESC, e.created_at, e.id`,
    [orgId],
  );
