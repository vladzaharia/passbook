import { run } from '../../platform/db.ts';
import { clearSettingsCache } from '../settings/service.ts';

/** Sets `oidc.trustEmail` (null: the default, off) and drops the settings cache. */
export async function setOidcTrust(db: D1Database, on: boolean | null): Promise<void> {
  await run(db, "DELETE FROM settings WHERE key = 'oidc.trustEmail'");
  if (on !== null)
    await run(
      db,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'oidc.trustEmail', ?, 0)",
      [String(on)],
    );
  clearSettingsCache(db);
}
