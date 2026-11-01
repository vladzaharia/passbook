import { all, batch, first, run, stmt } from '../../platform/db.ts';

export interface SettingRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: number;
}

export function readScopeRows(db: D1Database, scope: string): Promise<SettingRow[]> {
  return all<SettingRow>(
    db,
    'SELECT key, value, updated_by, updated_at FROM settings WHERE scope = ?',
    [scope],
  );
}

export async function writeScope(
  db: D1Database,
  scope: string,
  upserts: Record<string, unknown>,
  deletes: string[],
  by: string | null,
  now: number,
): Promise<void> {
  await batch(db, [
    ...Object.entries(upserts).map(([key, value]) =>
      stmt(
        db,
        `INSERT INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [scope, key, JSON.stringify(value), by, now],
      ),
    ),
    ...deletes.map((key) =>
      stmt(db, 'DELETE FROM settings WHERE scope = ? AND key = ?', [scope, key]),
    ),
  ]);
}

export async function orgExists(db: D1Database, orgId: string): Promise<boolean> {
  return (
    (await first(db, "SELECT 1 AS x FROM orgs WHERE id = ? AND status != 'deleted'", [orgId])) !==
    null
  );
}

/** Internal state (cron runs, identity checks). Not exposed through the settings API. */
export async function readSystemValue(db: D1Database, key: string): Promise<unknown | null> {
  const row = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
    [key],
  );
  return row ? JSON.parse(row.value) : null;
}

export async function writeSystemValue(
  db: D1Database,
  key: string,
  value: unknown,
  now: number,
): Promise<void> {
  await run(
    db,
    `INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', ?, ?, ?)
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), now],
  );
}

/**
 * Active users with no OIDC identity, so email (magic link) is their only way in. Addresses on the
 * reserved .invalid TLD (the break-glass account) receive no mail and are left out.
 */
export async function countEmailOnlyUsers(db: D1Database): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM users u
     WHERE u.status = 'active' AND u.primary_email NOT LIKE '%.invalid'
       AND NOT EXISTS (SELECT 1 FROM auth_identities a WHERE a.user_id = u.id)`,
  );
  return row?.n ?? 0;
}
