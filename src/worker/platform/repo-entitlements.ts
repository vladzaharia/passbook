import { all } from './db.ts';

export interface EntitlementRow {
  key: string;
  value: string;
}

/** The resolved values of one org: unexpired override over preset. An org with no row has none. */
export const entitlementRows = (db: D1Database, orgId: string): Promise<EntitlementRow[]> =>
  all<EntitlementRow>(db, 'SELECT key, value FROM org_entitlement_values WHERE org_id = ?', [
    orgId,
  ]);
