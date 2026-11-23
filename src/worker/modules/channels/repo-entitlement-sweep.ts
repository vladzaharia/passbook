import { all } from '../../platform/db.ts';

/** Orgs whose entitlements changed in the window: the newest revision is the one that may have lost its job. */
export const recentEntitlementOrgs = (db: D1Database, from: number, to: number, limit: number) =>
  all<{ org_id: string; revision: number }>(
    db,
    `SELECT e.org_id, e.revision FROM org_entitlements e JOIN orgs o ON o.id = e.org_id
     WHERE e.updated_at BETWEEN ? AND ? AND o.status = 'active' ORDER BY e.updated_at LIMIT ?`,
    [from, to, limit],
  );

/** The audit row of the org's newest entitlement change. */
export const latestEntitlementAudit = (db: D1Database, orgId: string) =>
  all<{ detail: string | null }>(
    db,
    `SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.entitlements_update'
     ORDER BY id DESC LIMIT 1`,
    [orgId],
  );
