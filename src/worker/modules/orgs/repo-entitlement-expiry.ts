import { all } from '../../platform/db.ts';

export const BATCH = 25;

/** Orgs with an override whose time has passed and that is still stored (a save or the expiry hook removes it). */
export const expiredOrgs = (db: D1Database, now: number, limit: number) =>
  all<{ org_id: string }>(
    db,
    `SELECT DISTINCT v.org_id FROM org_entitlement_overrides v JOIN orgs o ON o.id = v.org_id
     WHERE v.expires_at IS NOT NULL AND v.expires_at <= ? AND o.status = 'active' ORDER BY v.org_id LIMIT ?`,
    [now, limit],
  );
