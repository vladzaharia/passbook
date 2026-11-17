import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

type Migration = { name: string; queries: string[] };
const migrations = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * SQLite compiles a trigger's body, and the triggers it fires, when a statement on the table is
 * compiled. A trigger that names a column or table a later migration adds fails every write to its
 * table until that migration runs, which the old Worker meets mid-cutover. Compile an UPDATE of each
 * column and a DELETE on every table that has a trigger (WHERE 0: no row changes).
 */
async function probe(db: D1Database): Promise<Set<string>> {
  const tables = await db
    .prepare(
      "SELECT DISTINCT t.name FROM sqlite_master t JOIN sqlite_master g ON g.type = 'trigger' AND g.tbl_name = t.name WHERE t.type = 'table' ORDER BY t.name",
    )
    .all<{ name: string }>();
  const failures = new Set<string>();
  for (const { name } of tables.results) {
    // hidden = 0: ordinary columns. Generated and virtual-table columns cannot be assigned.
    const columns = await db
      .prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0')
      .bind(name)
      .all<{ name: string }>();
    const statements = [
      `DELETE FROM ${quote(name)} WHERE 0`,
      ...columns.results.map(
        (c) => `UPDATE ${quote(name)} SET ${quote(c.name)} = ${quote(c.name)} WHERE 0`,
      ),
    ];
    for (const sql of statements) {
      try {
        await db.prepare(sql).run();
      } catch (error) {
        failures.add(`${name}: ${(error as Error).message}`);
      }
    }
  }
  return failures;
}

/**
 * The guards 0043-0049 add to passes, wallet_provider_instances and pass_credential_transfers are deeper than D1's
 * expression-tree limit of 100 until 0050 narrows them: a database stopped in that range refuses writes to
 * those tables. Applying the whole chain is unaffected. Any later prefix must compile cleanly.
 */
const KNOWN_DEPTH = /^00(4[3-9])_/;
const DEPTH = 'Expression tree is too large';

describe('migration prefixes', () => {
  it('compile every write on every table with triggers after each migration', async () => {
    const db = (env as unknown as Record<string, D1Database | undefined>).KEYSET_TEST_DB_0;
    if (!db) throw new Error('No isolated D1 binding');
    const bad: string[] = [];
    for (const migration of migrations) {
      await applyD1Migrations(db, [migration]);
      for (const failure of await probe(db)) {
        if (failure.includes(DEPTH) && KNOWN_DEPTH.test(migration.name)) continue;
        bad.push(`after ${migration.name}: ${failure}`);
      }
    }
    expect(bad).toEqual([]);
  }, 300_000);
});
