import { all, first } from '../../platform/db.ts';
import { userLabelSql } from '../orgs/repo-user-label.ts';
import type { ApiKeyRow } from './repo-row.ts';

type Db = D1Database;

/** A key with the names of its family, the creator's label and its open children. */
export interface KeyDetailRow extends ApiKeyRow {
  created_by_name: string | null;
  parent: string | null;
  replaced_by: string | null;
  child_count: number;
}

export const getKeyDetail = (db: Db, id: string, orgId: string | null, platform: boolean) =>
  first<KeyDetailRow>(
    db,
    `SELECT k.*,
       CASE WHEN k.created_by IS NULL THEN NULL
         ELSE ${userLabelSql('k.created_by', 'k.org_id', platform)} END AS created_by_name,
       (SELECT json_object('id', p.id, 'name', p.name) FROM api_keys p WHERE p.id = k.parent_key_id) AS parent,
       (SELECT json_object('id', r.id, 'name', r.name) FROM api_keys r
        WHERE r.rotated_from = k.id ORDER BY r.created_at, r.id LIMIT 1) AS replaced_by,
       (SELECT count(*) FROM api_keys c WHERE c.parent_key_id = k.id AND c.revoked_at IS NULL) AS child_count
     FROM api_keys k WHERE k.id = ? AND k.org_id IS ?`,
    [id, orgId],
  );

export interface CallRow {
  id: number;
  at: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_prefix: string | null;
  code: string | null;
}

/** The key's latest audit rows, newest first. Only the refusal code is read from `detail`: nothing a caller sent. */
export const recentCalls = (db: Db, keyId: string, limit: number) =>
  all<CallRow>(
    db,
    `SELECT id, at, action, target_type, target_id, ip_prefix,
       CASE WHEN action = 'auth.denied' THEN json_extract(detail, '$.code') END AS code
     FROM audit_log WHERE actor_type = 'api_key' AND actor_id = ?
     ORDER BY id DESC LIMIT ?`,
    [keyId, limit],
  );

/** Calls per action since `since`, most frequent first. */
export const callSummary = (db: Db, keyId: string, since: number) =>
  all<{ action: string; n: number; last_at: number }>(
    db,
    `SELECT action, count(*) AS n, max(at) AS last_at FROM audit_log
     WHERE actor_type = 'api_key' AND actor_id = ? AND at >= ?
     GROUP BY action ORDER BY n DESC, action LIMIT 30`,
    [keyId, since],
  );
