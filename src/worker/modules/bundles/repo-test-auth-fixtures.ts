import { FAKE_KEY_CREATOR } from '../../../../test/helpers/fake-auth.ts';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import type { ApiKeyAuth, SessionAuth } from '../../platform/auth.ts';
import { all, run } from '../../platform/db.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';

export async function insertBundleApiKey(kit: Kit, key: ApiKeyAuth) {
  // A platform key lives only while its creator is an active admin.
  const creator = key.orgId === null ? FAKE_KEY_CREATOR : null;
  if (creator)
    await run(
      kit.env.DB,
      `INSERT OR IGNORE INTO users (id, primary_email, created_at, last_roles) VALUES (?, ?, ?, '["admin"]')`,
      [creator, `${creator}@fake-auth.test`, kit.clock.now()],
    );
  const insert = () =>
    run(
      kit.env.DB,
      // Not OR IGNORE: the api_keys insert guard (0039) aborts on an existing key.
      // An org-less key stands for a platform key from before 0142: unbounded, past the insert rules.
      `INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, mode, created_at, kind, created_by, created_amr, creator_access_revision)
    SELECT ?, ?, 'bundle fixture', ?, ?, ?, ?, ?, ?, ?, ?, (SELECT access_revision FROM users WHERE id = ?) WHERE NOT EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`,
      [
        key.keyId,
        key.orgId,
        key.keyId,
        key.keyId,
        JSON.stringify(key.scopes),
        key.mode,
        kit.clock.now(),
        key.orgId === null ? 'platform' : 'service',
        creator,
        creator ? 'oidc' : null,
        creator,
        key.keyId,
      ],
    );
  await (key.orgId === null ? withoutTrigger(kit.env.DB, 'api_keys_kind_rules', insert) : insert());
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
