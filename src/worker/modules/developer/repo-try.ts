import type { Amr } from '../../platform/auth.ts';
import { first } from '../../platform/db.ts';
import { consoleSessionSql } from '../../platform/repo-session-strength-sql.ts';
import { RESOLVED_KEY_COLUMNS, type ResolvedKeyRow } from '../api-keys/repo.ts';
import { TRY_REQUIRED_SCOPES } from './key-scopes.ts';

/**
 * The key a try token is minted for: the person's newest personal Test key in their open sandbox that holds the
 * sandbox key's scopes (`required`), held through their live membership, neither revoked, expiring nor retiring,
 * unrestricted and not a child. A narrower key, however new, is never the one: the token stays as wide as the
 * sandbox key and no wider than a key the person already holds. With the sandbox's
 * try generation. Null without an open sandbox or such a key; `key_id` null when only the key is missing.
 */
export const tryKeyOf = (
  db: D1Database,
  userId: string,
  now: number,
  required: readonly string[] = TRY_REQUIRED_SCOPES,
) =>
  first<{ key_id: string | null; try_generation: number }>(
    db,
    `SELECT d.try_generation,
       (SELECT k.id FROM api_keys k JOIN org_memberships m ON m.id = k.membership_id
        WHERE k.org_id = d.org_id AND m.org_id = d.org_id AND m.user_id = d.user_id AND m.revoked_at IS NULL
          AND k.kind = 'personal' AND k.mode = 'test' AND k.revoked_at IS NULL AND k.retire_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > ?2) AND k.restricted = 0 AND k.parent_key_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(?3) r
                          WHERE r.value NOT IN (SELECT s.value FROM json_each(k.scopes) s))
        ORDER BY k.created_at DESC, k.rowid DESC LIMIT 1) AS key_id
     FROM developer_sandboxes d JOIN orgs o ON o.id = d.org_id AND o.kind = 'developer' AND o.status = 'active'
     WHERE d.user_id = ?1 AND d.closed_at IS NULL`,
    [userId, now, JSON.stringify(required)],
  );

/**
 * The key row behind a try token, only while every binding holds: a personal Test key of a developer org, whose
 * sandbox is open at the token's generation, held by the sandbox's person, whose session named in the token is
 * live; with that session's `auth_time`, which step-up reads. The key's own rules (revoked, expired, org and member live) are applied by `keyAuthOf`.
 */
export const tryTokenKeyRow = (
  db: D1Database,
  claims: { keyId: string; sessionIdHash: string; generation: number },
  now: number,
) =>
  first<ResolvedKeyRow & { session_auth_time: number | null; session_amr: Amr }>(
    db,
    `SELECT ${RESOLVED_KEY_COLUMNS}, s.auth_time AS session_auth_time, s.amr AS session_amr
     FROM api_keys k
     JOIN orgs o ON o.id = k.org_id AND o.kind = 'developer'
     JOIN developer_sandboxes d ON d.org_id = k.org_id AND d.closed_at IS NULL AND d.try_generation = ?3
     JOIN org_memberships m ON m.id = k.membership_id AND m.org_id = k.org_id AND m.user_id = d.user_id
     JOIN sessions s ON s.id_hash = ?2 AND s.user_id = d.user_id AND s.revoked_at IS NULL
       AND s.expires_at > ?4 AND s.idle_expires_at > ?4 AND ${consoleSessionSql('s', '?4')}
     WHERE k.id = ?1 AND k.kind = 'personal' AND k.mode = 'test'`,
    [claims.keyId, claims.sessionIdHash, claims.generation, now],
  );
