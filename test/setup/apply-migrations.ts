import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach } from 'vitest';
import { assertNoLeakedGrants } from '../helpers/grant-leak.ts';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const triggers = async () =>
  new Map(
    (
      await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all<{
        name: string;
        sql: string;
      }>()
    ).results.map((row) => [row.name, row.sql]),
  );
const keyset = () => env.DB.prepare('SELECT id, commitment FROM credential_ref_keyset').all();
const migrated = await triggers();
type KeysetRow = { id: number; commitment: string };
let keysetBefore: KeysetRow[] = [];
beforeEach(async () => {
  keysetBefore = (await keyset()).results as KeysetRow[];
});

// Storage lasts for the whole file, so a trigger or the keyset singleton changed by one test
// must not reach the next. A keyset that was absent may be legitimately initialized by a test
// (later rows depend on it), so only a row that existed before the test is restored. The keyset
// is immutable by trigger, so restoring it drops the guards first; migrated triggers are
// recreated right after.
afterEach(async () => {
  const current = await triggers();
  for (const [name, sql] of current)
    if (migrated.get(name) !== sql) await env.DB.prepare(`DROP TRIGGER "${name}"`).run();
  const rows = (await keyset()).results as KeysetRow[];
  if (keysetBefore.length > 0 && JSON.stringify(rows) !== JSON.stringify(keysetBefore)) {
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
  const remaining = await triggers();
  for (const [name, sql] of migrated) if (!remaining.has(name)) await env.DB.prepare(sql).run();
  await assertNoLeakedGrants(env.DB);
});
