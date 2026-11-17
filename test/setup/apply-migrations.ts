import { env } from 'cloudflare:workers';
import { afterEach, beforeEach } from 'vitest';
import snapshot from './schema-snapshot.generated.json';

// The fully migrated schema and seed data in one batch (tools/build-test-schema.ts).
// test/schema-snapshot.test.ts proves it equals what the real migrations produce.
await env.DB.batch([
  env.DB.prepare('PRAGMA defer_foreign_keys = ON'),
  ...(snapshot as string[]).map((sql) => env.DB.prepare(sql)),
]);

const triggers = async () =>
  new Map(
    (
      await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all<{
        name: string;
        sql: string;
      }>()
    ).results.map((row) => [row.name, row.sql]),
  );
type KeysetRow = { id: number; commitment: string };
// One round trip: a trigger fingerprint (count, total sql length and rowids: a dropped, added or
// re-created trigger changes it; the sqlite_master walk below runs only then), the keyset,
// and, when `leaks`, the grant rows that outlived their batch (authority-epochs.md section 1.2).
const state = async (leaks: boolean) => {
  const { DB } = env;
  const [print, keyset, grants] = await DB.batch([
    DB.prepare(
      "SELECT count(*) || ':' || total(length(sql)) || ':' || total(rowid) AS v FROM sqlite_master WHERE type='trigger'",
    ),
    DB.prepare('SELECT id, commitment FROM credential_ref_keyset'),
    DB.prepare(leaks ? 'DELETE FROM authority_grants RETURNING id, purpose' : 'SELECT 1 WHERE 0'),
    ...(leaks ? [DB.prepare('DELETE FROM authority_grant_leaks')] : []),
  ]);
  return {
    print: String((print?.results[0] as { v: string } | undefined)?.v),
    keyset: (keyset?.results ?? []) as KeysetRow[],
    grants: (grants?.results ?? []) as { id: string; purpose: string }[],
  };
};
const migrated = await triggers();
const migratedPrint = (await state(false)).print;
let keysetBefore: KeysetRow[] = [];
beforeEach(async () => {
  keysetBefore = (await state(false)).keyset;
});

// Storage lasts for the whole file, so a trigger or the keyset singleton changed by one test
// must not reach the next. A keyset that was absent may be legitimately initialized by a test
// (later rows depend on it), so only a row that existed before the test is restored. The keyset
// is immutable by trigger, so restoring it drops the guards first; migrated triggers are
// recreated right after.
afterEach(async () => {
  const now = await state(true);
  if (now.print !== migratedPrint) {
    const current = await triggers();
    for (const [name, sql] of current)
      if (migrated.get(name) !== sql) await env.DB.prepare(`DROP TRIGGER "${name}"`).run();
  }
  if (keysetBefore.length > 0 && JSON.stringify(now.keyset) !== JSON.stringify(keysetBefore)) {
    for (const name of [
      'credential_ref_keyset_insert_guard',
      'credential_ref_keyset_no_update',
      'credential_ref_keyset_no_delete',
    ])
      await env.DB.prepare(`DROP TRIGGER IF EXISTS "${name}"`).run();
    await env.DB.prepare('DELETE FROM credential_ref_keyset').run();
    for (const row of keysetBefore)
      await env.DB.prepare('INSERT INTO credential_ref_keyset (id, commitment) VALUES (?, ?)')
        .bind(row.id, row.commitment)
        .run();
  }
  if (now.print !== migratedPrint) {
    const remaining = await triggers();
    for (const [name, sql] of migrated) if (!remaining.has(name)) await env.DB.prepare(sql).run();
  }
  if (now.grants.length > 0)
    throw new Error(
      `AUTHORITY_GRANT_LEAK: ${now.grants.map((r) => r.purpose).join(', ')} left a grant row behind`,
    );
});
