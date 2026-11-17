// Part of `npm run gen`: worker tests start from this snapshot of the fully migrated database
// instead of replaying every migration per test file. test/schema-snapshot.test.ts proves the real
// migrations still produce exactly this schema and seed data.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const migrationsDir = resolve(root, 'migrations');
const target = resolve(root, 'test/setup/schema-snapshot.generated.json');

type MasterRow = { type: string; name: string; tbl_name: string; sql: string };

export function buildSnapshot(): string[] {
  const db = new DatabaseSync(':memory:');
  const names = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // d1_migrations is created by the D1 migration runner (same shape as applyD1Migrations).
  db.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations" (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
	);`);
  for (const name of names) {
    db.exec(readFileSync(resolve(migrationsDir, name), 'utf8'));
    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
  }
  db.exec("UPDATE d1_migrations SET applied_at = '2000-01-01 00:00:00'");
  const master = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all() as MasterRow[];
  const statements: string[] = [];
  const tables = master.filter((row) => row.type === 'table');
  for (const table of tables) statements.push(table.sql);
  for (const table of tables) {
    const columns = (
      db.prepare(`SELECT name FROM pragma_table_info('${table.name}')`).all() as {
        name: string;
      }[]
    ).map((col) => `"${col.name}"`);
    const quoted = columns.map((col) => `quote(${col})`).join(" || ',' || ");
    const order = /WITHOUT\s+ROWID/i.test(table.sql) ? '' : ' ORDER BY rowid';
    const rows = db.prepare(`SELECT ${quoted} AS v FROM "${table.name}"${order}`).all() as {
      v: string;
    }[];
    for (const row of rows)
      statements.push(`INSERT INTO "${table.name}" (${columns.join(',')}) VALUES (${row.v})`);
  }
  for (const type of ['index', 'view', 'trigger'])
    for (const row of master) if (row.type === type) statements.push(row.sql);
  db.close();
  return statements;
}

if (import.meta.main) {
  const statements = buildSnapshot();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(statements)}\n`);
  console.log(`test schema snapshot: ${statements.length} statements`);
}
