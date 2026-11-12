import { first, run, type SqlValue } from '../../src/worker/platform/db.ts';

/** Run `fn` with a migrated trigger dropped; the trigger's own sqlite_master SQL is always restored. */
export async function withoutTrigger<T>(
  db: D1Database,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const trigger = await first<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    [name],
  );
  if (!trigger) throw new Error(`Missing trigger ${name}`);
  await run(db, `DROP TRIGGER "${name}"`);
  try {
    return await fn();
  } finally {
    await run(db, `DROP TRIGGER IF EXISTS "${name}"`);
    await run(db, trigger.sql);
  }
}

/**
 * Rewrites a session's roles or amr, which `sessions_authority_immutable` (0047) forbids in
 * production, to simulate a changed session. The worker test setup restores the trigger afterwards.
 */
export async function editSessionAuthority(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<{ changes: number }> {
  await db.prepare('DROP TRIGGER IF EXISTS sessions_authority_immutable').run();
  return run(db, sql, params);
}

/**
 * Ages or rewrites a fixed column (`created_at`, `created_by`, `id`) that `<table>_fixed_columns` (0052)
 * forbids in production. The worker test setup restores the trigger after the test.
 */
export async function editFixedColumns(
  db: D1Database,
  table: string,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<{ changes: number }> {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Invalid table: ${table}`);
  await db.prepare(`DROP TRIGGER IF EXISTS ${table}_fixed_columns`).run();
  return run(db, sql, params);
}

/**
 * Lets a test insert a membership or invitation with unknown or duplicate role names, which the
 * `*_roles_valid` guards (0029) refuse. The worker test setup restores the triggers after the test.
 */
export async function allowInvalidRoleNames(db: D1Database): Promise<void> {
  await db.prepare('DROP TRIGGER IF EXISTS org_memberships_roles_valid').run();
  await db.prepare('DROP TRIGGER IF EXISTS org_invitations_roles_valid').run();
}

/**
 * Rewrites an API key's org, mode, scopes, expiry or creator, which `api_keys_identity_immutable` (0039)
 * forbids in production, to simulate a changed key. The worker test setup restores the trigger afterwards.
 */
export async function editApiKeyIdentity(
  db: D1Database,
  sql: string,
  params: readonly SqlValue[] = [],
): Promise<{ changes: number }> {
  await db.prepare('DROP TRIGGER IF EXISTS api_keys_identity_immutable').run();
  return run(db, sql, params);
}
