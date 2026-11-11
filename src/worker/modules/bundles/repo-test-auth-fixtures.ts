import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';

export async function insertBundleApiKey(kit: Kit, key: ApiKeyAuth) {
  await run(
    kit.env.DB,
    // Not OR IGNORE: the api_keys insert guard (0039) aborts on an existing key.
    `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at)
    SELECT ?, ?, 'bundle fixture', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`,
    [
      key.keyId,
      key.orgId,
      key.keyId,
      key.keyId,
      JSON.stringify(key.scopes),
      key.mode,
      kit.clock.now(),
      key.keyId,
    ],
  );
}

export function listBundleOrgs(kit: Kit) {
  return all<{ id: string }>(kit.env.DB, 'SELECT id FROM orgs');
}

export async function insertBundleSession(kit: Kit, session: SessionAuth, now: number) {
  await run(
    kit.env.DB,
    `INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)`,
    [
      session.sessionId,
      session.userId,
      session.amr,
      JSON.stringify(session.roles),
      session.csrfSecret,
      now,
      now,
      now + 86400000,
      now + 86400000,
      session.sessionId,
    ],
  );
}
