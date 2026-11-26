import { all } from '../../platform/db.ts';

export interface UserPassRow {
  id: string;
  org_id: string;
  name: string;
  personal_user_id: string | null;
  org_status: 'active' | 'suspended';
  time_zone: string | null;
  template_name: string;
  status: 'active' | 'voided';
  owned: number;
  has_apple: number;
  has_google: number;
  has_samsung: number;
  created_at: number;
  modified_at: number;
}

/** Verified addresses only (`user_emails`); an unproven primary email is a claim, not proof. */
export const MAX_EMAILS = 20;
export const verifiedEmails = (db: D1Database, userId: string) =>
  all<{ email: string }>(db, 'SELECT email FROM user_emails WHERE user_id = ? LIMIT ?', [
    userId,
    MAX_EMAILS,
  ]).then((rows) => rows.map((r) => r.email));

const FILTERS = `p.id < ?2 AND p.deleted_at IS NULL AND p.mode = 'live' AND p.test_data_quarantined = 0
  AND o.status IN ('active', 'suspended')
  AND (o.personal_user_id IS NULL OR o.personal_user_id = ?4)`;

/**
 * The newest `limit` ids of one branch, in index order (`passes_owner_live`, `passes_waiting_live`).
 * `holder` is the owner id, or a verified address for the waiting branch. Waiting passes made by a
 * public join link are left out: anyone could have typed the address.
 */
export const branchIds = (
  db: D1Database,
  kind: 'owner' | 'waiting',
  holder: string,
  cursor: string,
  limit: number,
  viewerId: string,
) =>
  all<{ id: string }>(
    db,
    `SELECT p.id FROM passes p JOIN orgs o ON o.id = p.org_id
     WHERE ${
       kind === 'owner'
         ? 'p.owner_user_id = ?1'
         : 'p.owner_user_id IS NULL AND p.holder_email = ?1 AND NOT EXISTS (SELECT 1 FROM join_marks j WHERE j.pass_id = p.id)'
     } AND ${FILTERS}
     ORDER BY p.id DESC LIMIT ?3`,
    [holder, cursor, limit, viewerId],
  );

/** The page's rows, read by id only: the correlated lookups run for at most `limit` passes. */
export const passesByIds = (db: D1Database, ids: readonly string[]) =>
  all<UserPassRow>(
    db,
    `SELECT p.id, p.org_id, o.name, o.personal_user_id, o.status AS org_status,
            (SELECT json_extract(s.value, '$') FROM settings s
              WHERE s.scope = 'org:' || o.id AND s.key = 'org.timeZone') AS time_zone,
            COALESCE(t.name, p.template_id) AS template_name, p.status,
            p.owner_user_id IS NOT NULL AS owned,
            EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id) AS has_apple,
            EXISTS (SELECT 1 FROM wallet_provider_instances i
                     WHERE i.pass_id = p.id AND i.provider = 'google' AND i.lifecycle = 'active') AS has_google,
            EXISTS (SELECT 1 FROM wallet_provider_instances i
                     WHERE i.pass_id = p.id AND i.provider = 'samsung' AND i.lifecycle = 'active') AS has_samsung,
            p.created_at, p.modified_at
     FROM passes p
     JOIN orgs o ON o.id = p.org_id
     LEFT JOIN templates t ON t.id = p.template_id
     WHERE p.id IN (SELECT value FROM json_each(?))
     ORDER BY p.id DESC`,
    [JSON.stringify(ids)],
  );
