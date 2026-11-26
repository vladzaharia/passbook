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
  all<{ email: string }>(
    db,
    'SELECT email FROM user_emails WHERE user_id = ? ORDER BY verified_at DESC, email LIMIT ?',
    [userId, MAX_EMAILS + 1],
  ).then((rows) => rows.map((r) => r.email));

/** Rows one branch reads from its index before it stops and answers with a "more" cursor. */
export const SCAN_CAP = 500;

const INDEXED = `p.id < ?2 AND p.deleted_at IS NULL AND p.mode = 'live' AND p.test_data_quarantined = 0`;
const UNINDEXED = `o.status IN ('active', 'suspended')
  AND (o.personal_user_id IS NULL OR o.personal_user_id = ?2)`;

export interface Branch {
  ids: string[];
  /** Set when the walk hit the cap with too few matches: ids below it were not read. */
  scannedTo: string | null;
}

/**
 * The newest `limit` matching ids of one branch, in index order (`passes_owner_live`,
 * `passes_waiting_live`). Only the index-covered rows are walked, at most `cap`; the org and join
 * checks then run on those. `holder` is the owner id, or a verified address for the waiting branch.
 * Waiting passes made by a public join link are left out: anyone could have typed the address.
 */
export async function branchIds(
  db: D1Database,
  kind: 'owner' | 'waiting',
  holder: string,
  cursor: string,
  limit: number,
  viewerId: string,
  cap = SCAN_CAP,
): Promise<Branch> {
  const scanned = await all<{ id: string }>(
    db,
    `SELECT p.id FROM passes p
     WHERE ${kind === 'owner' ? 'p.owner_user_id = ?1' : 'p.owner_user_id IS NULL AND p.holder_email = ?1'}
       AND ${INDEXED}
     ORDER BY p.id DESC LIMIT ?3`,
    [holder, cursor, cap],
  );
  if (scanned.length === 0) return { ids: [], scannedTo: null };
  const kept = await all<{ id: string }>(
    db,
    `SELECT p.id FROM passes p JOIN orgs o ON o.id = p.org_id
     WHERE p.id IN (SELECT value FROM json_each(?1)) AND ${UNINDEXED.replace('?2', '?3')}
       ${kind === 'waiting' ? 'AND NOT EXISTS (SELECT 1 FROM join_marks j WHERE j.pass_id = p.id)' : ''}
     ORDER BY p.id DESC LIMIT ?2`,
    [JSON.stringify(scanned.map((r) => r.id)), limit, viewerId],
  );
  const capped = scanned.length === cap && kept.length < limit;
  return { ids: kept.map((r) => r.id), scannedTo: capped ? (scanned.at(-1)?.id ?? null) : null };
}

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
