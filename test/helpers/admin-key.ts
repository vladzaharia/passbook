import { createApiKeyStore } from '../../src/worker/modules/api-keys/service.ts';
import { first, run } from '../../src/worker/platform/db.ts';
import { keyLive } from '../../src/worker/platform/repo-api-key-sql.ts';
import { type Fixtures, makeApiKey } from './factories.ts';

/** A platform-kind key made by `userId` as an admin: their last sign-in held admin, and the key records their revision. */
export async function adminKey(f: Fixtures, userId: string) {
  await run(f.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [userId]);
  return makeApiKey(f, {
    orgId: null,
    kind: 'platform',
    scopes: ['platform:orgs'],
    expiresAt: f.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
    createdBy: userId,
  });
}

/** Whether the key passes the gate (`keyAuthOf`) and a grant's actor check (`keyLive`, which a commit re-runs). */
export async function keyState(f: Fixtures, key: { id: string; secret: string }) {
  const resolved = await createApiKeyStore(f.env, f.clock).resolve(key.secret, {
    ip: '198.51.100.7',
    browser: false,
    cookie: false,
  } as never);
  const live = keyLive('k', f.clock.now(), true);
  const row = await first<{ live: number }>(
    f.env.DB,
    `SELECT ${live.sql} AS live FROM api_keys k WHERE k.id = ?`,
    [...live.params, key.id],
  );
  return { gate: resolved !== null, grant: row?.live === 1 };
}
