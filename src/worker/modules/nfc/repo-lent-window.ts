import { all } from '../../platform/db.ts';

export interface Lent {
  id: string;
  mode: 'live' | 'test';
  bound_at: number;
  expires_at: number | null;
  binding_days: number | null;
}

const LENT_SQL = `SELECT b.id, t.mode, b.bound_at, b.expires_at, y.binding_days
  FROM tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id JOIN nfc_tag_types y ON y.id = t.type_id
  WHERE b.pass_id = ? AND b.scope = 'pass' AND b.ended_at IS NULL AND t.org_id = ? AND y.org_id = ? AND y.use = 'visitor'`;

/** The active lent tags of a pass, with the type's `binding_days`. */
export const lentBindings = (db: D1Database, passId: string, orgId: string, limit = 50) =>
  all<Lent>(db, `${LENT_SQL} LIMIT ?`, [passId, orgId, orgId, limit]);
