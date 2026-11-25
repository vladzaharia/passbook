import { all } from '../../platform/db.ts';

export interface UserPassRow {
  id: string;
  org_id: string;
  org_name: string;
  org_status: 'active' | 'suspended';
  time_zone: string | null;
  template_name: string;
  status: 'active' | 'voided';
  has_apple: number;
  has_google: number;
  has_samsung: number;
  created_at: number;
  modified_at: number;
}

/**
 * Newest first, across organizations, in one query. A person's pass is one they own, or one still
 * waiting for a verified address of theirs (`user_emails` holds verified addresses only). Both
 * branches use an index (`passes_owner`, `passes_holder_email`). Passes of a deleted organization,
 * deleted passes and test passes are left out. The cursor is the last pass id (UUIDv7).
 */
export const listUserPasses = (
  db: D1Database,
  userId: string,
  cursor: string | undefined,
  limit: number,
) =>
  all<UserPassRow>(
    db,
    `SELECT p.id, p.org_id, o.name AS org_name, o.status AS org_status,
            (SELECT json_extract(s.value, '$') FROM settings s
              WHERE s.scope = 'org:' || o.id AND s.key = 'org.timeZone') AS time_zone,
            COALESCE(t.name, p.template_id) AS template_name, p.status,
            EXISTS (SELECT 1 FROM registrations r WHERE r.pass_id = p.id) AS has_apple,
            EXISTS (SELECT 1 FROM wallet_provider_instances i
                     WHERE i.pass_id = p.id AND i.provider = 'google'
                       AND i.lifecycle IN ('ready', 'active')) AS has_google,
            EXISTS (SELECT 1 FROM wallet_provider_instances i
                     WHERE i.pass_id = p.id AND i.provider = 'samsung'
                       AND i.lifecycle IN ('ready', 'active')) AS has_samsung,
            p.created_at, p.modified_at
     FROM passes p
     JOIN orgs o ON o.id = p.org_id
     LEFT JOIN templates t ON t.id = p.template_id
     WHERE p.id IN (
         SELECT id FROM passes WHERE owner_user_id = ?1 AND id < ?2
         UNION
         SELECT id FROM passes
          WHERE owner_user_id IS NULL AND id < ?2 AND holder_email IN (
            SELECT email FROM user_emails WHERE user_id = ?1
            UNION SELECT primary_email FROM users WHERE id = ?1))
       AND o.status IN ('active', 'suspended')
       AND p.deleted_at IS NULL AND p.mode = 'live'
     ORDER BY p.id DESC LIMIT ?3`,
    [userId, cursor ?? '~', limit],
  );
