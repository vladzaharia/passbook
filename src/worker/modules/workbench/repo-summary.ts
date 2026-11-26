import { first, type SqlValue } from '../../platform/db.ts';

const count = async (db: D1Database, sql: string, params: SqlValue[]) =>
  (await first<{ n: number }>(db, sql, params))?.n ?? 0;

/** Test calls that failed after `since`, inside the log's metadata window. */
export const errorsSince = (db: D1Database, orgId: string, since: number, floor: number) =>
  count(
    db,
    `SELECT COUNT(*) AS n FROM request_log
     WHERE org_id = ? AND mode = 'test' AND status >= 400 AND at > ? AND at >= ?`,
    [orgId, since, floor],
  );

export const emailsSince = (db: D1Database, orgId: string, since: number) =>
  count(db, 'SELECT COUNT(*) AS n FROM captured_emails WHERE org_id = ? AND created_at > ?', [
    orgId,
    since,
  ]);

/** Test keys that still work and expire inside the window. */
export const keysExpiringBetween = (db: D1Database, orgId: string, from: number, to: number) =>
  count(
    db,
    `SELECT COUNT(*) AS n FROM api_keys
     WHERE org_id = ? AND mode = 'test' AND revoked_at IS NULL AND expires_at > ? AND expires_at <= ?`,
    [orgId, from, to],
  );

export const hasActiveTestEndpoint = async (db: D1Database, orgId: string) =>
  (await count(
    db,
    `SELECT COUNT(*) AS n FROM webhook_endpoints WHERE org_id = ? AND mode = 'test' AND status = 'active'`,
    [orgId],
  )) > 0;

export const templatesHeld = (db: D1Database, orgId: string) =>
  count(db, 'SELECT COUNT(*) AS n FROM templates WHERE org_id = ?', [orgId]);

/** Endpoints take a slot across the org's modes (webhooks/repo-endpoints.ts `endpointSlot`). */
export const endpointsHeld = (db: D1Database, orgId: string) =>
  count(db, 'SELECT COUNT(*) AS n FROM webhook_endpoints WHERE org_id = ?', [orgId]);

export const keysHeld = (db: D1Database, orgId: string, now: number) =>
  count(
    db,
    `SELECT COUNT(*) AS n FROM api_keys
     WHERE org_id = ? AND revoked_at IS NULL AND (retire_at IS NULL OR retire_at > ?)`,
    [orgId, now],
  );
