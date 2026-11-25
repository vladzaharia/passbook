import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

type Migration = { name: string; queries: string[] };
const migrations = (env as unknown as { TEST_MIGRATIONS: Migration[] }).TEST_MIGRATIONS;
const number = (m: Migration) => Number.parseInt(m.name.slice(0, 4), 10);
const databases = env as unknown as Record<string, D1Database | undefined>;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

type Statement = 'INSERT' | 'UPDATE' | 'DELETE';
interface Failure {
  table: string;
  statement: Statement;
  column: string | null;
  message: string;
}

/**
 * SQLite compiles a trigger's body, and the triggers it fires, when a statement is compiled: on the
 * table, and on any table whose foreign keys fire it. A trigger that names a column or table a later
 * migration adds fails every such write until that migration runs, which the old Worker meets
 * mid-cutover. Compile a DELETE, an INSERT ... SELECT and an UPDATE of each column on every table
 * (WHERE 0: no row changes).
 */
async function probe(db: D1Database): Promise<Failure[]> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  const failures: Failure[] = [];
  for (const { name: table } of tables.results) {
    // hidden = 0: ordinary columns. Generated and virtual-table columns cannot be assigned.
    const columns = (
      await db
        .prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0')
        .bind(table)
        .all<{ name: string }>()
    ).results.map((c) => c.name);
    const t = quote(table);
    const list = columns.map(quote).join(', ');
    const statements: [Statement, string | null, string][] = [
      ['DELETE', null, `DELETE FROM ${t} WHERE 0`],
      ['INSERT', null, `INSERT INTO ${t} (${list}) SELECT ${list} FROM ${t} WHERE 0`],
      ...columns.map((c): [Statement, string, string] => [
        'UPDATE',
        c,
        `UPDATE ${t} SET ${quote(c)} = ${quote(c)} WHERE 0`,
      ]),
    ];
    for (const [statement, column, sql] of statements) {
      try {
        await db.prepare(sql).run();
      } catch (error) {
        failures.push({ table, statement, column, message: (error as Error).message });
      }
    }
  }
  return failures;
}

interface Known {
  table: string;
  statement: Statement;
  /** Null: any column of an UPDATE, or an INSERT or DELETE. */
  column: string | null;
  from: number;
  to: number;
  reason: string;
}

/**
 * Failures a database stopped between these migrations is known to have. Applying the whole chain is
 * unaffected. Each entry must still be hit, so a fixed one is removed here. No other prefix may fail.
 */
const KNOWN: Known[] = [
  ...[
    ['passes', 'credential_generation'],
    ['wallet_provider_instances', 'lifecycle'],
    ['pass_credential_transfers', 'state'],
  ].map(
    ([table, column]): Known => ({
      table: table as string,
      statement: 'UPDATE',
      column: column as string,
      from: 43,
      to: 49,
      reason:
        'its guard trigger is deeper than D1 allows (expression tree depth 100) until 0050 narrows it; the old Worker never writes this column',
    }),
  ),
  {
    table: 'credential_ref_keyset',
    statement: 'INSERT',
    column: null,
    from: 42,
    to: 45,
    reason:
      'the insert guard reads scan_asset_grant_provenance, which 0046 creates; failing closed keeps the keyset uninitialised, and only the new Worker initialises it',
  },
  {
    table: 'scan_passless_proofs',
    statement: 'INSERT',
    column: null,
    from: 41,
    to: 49,
    reason:
      'its insert guard is deeper than D1 allows until 0050 narrows it; the old Worker never writes this table',
  },
];

const matches = (k: Known, f: Failure, n: number) =>
  k.table === f.table &&
  k.statement === f.statement &&
  (k.column === null || k.column === f.column) &&
  n >= k.from &&
  n <= k.to;

describe('migration prefixes', () => {
  // One database walks the chain; each chunk probes its own slice with its own time budget.
  // A chunk run alone first applies the migrations before it, unprobed.
  const CHUNK = 30;
  const chunks = Array.from({ length: Math.ceil(migrations.length / CHUNK) }, (_, i) => i);
  const bad: string[] = [];
  const hit = new Set<Known>();
  let applied = 0;
  let probed = 0;

  it.each(chunks)(
    'compile every write on every table after each migration, but the listed ones (part %i)',
    async (part) => {
      const db = databases.KEYSET_TEST_DB_0;
      if (!db) throw new Error('No isolated D1 binding');
      const start = part * CHUNK;
      if (applied < start) await applyD1Migrations(db, migrations.slice(applied, start));
      applied = Math.max(applied, start);
      const before = bad.length;
      for (const migration of migrations.slice(start, start + CHUNK)) {
        await applyD1Migrations(db, [migration]);
        applied += 1;
        for (const f of await probe(db)) {
          const known = KNOWN.find((k) => matches(k, f, number(migration)));
          if (known) hit.add(known);
          else
            bad.push(
              `after ${migration.name}: ${f.statement} ${f.table}${f.column ? `.${f.column}` : ''}: ${f.message}`,
            );
        }
        probed += 1;
      }
      expect(bad.slice(before)).toEqual([]);
    },
    300_000,
  );

  it('every listed failure was hit by some migration', () => {
    // Only meaningful once every chunk has run in this file.
    if (probed < migrations.length) return;
    expect(KNOWN.filter((k) => !hit.has(k)).map((k) => `${k.statement} ${k.table}`)).toEqual([]);
  });

  it('the probe fails on a trigger that reads a missing column, for each statement', async () => {
    const db = databases.KEYSET_TEST_DB_1;
    if (!db) throw new Error('No isolated D1 binding');
    await db.exec('CREATE TABLE control (a INTEGER, b INTEGER)');
    for (const when of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = when === 'INSERT' ? 'NEW' : 'OLD';
      await db.exec(
        `CREATE TRIGGER control_${when} BEFORE ${when} ON control BEGIN SELECT RAISE(ABORT, 'x') WHERE ${row}.later_column = 1; END`,
      );
    }
    const failures = (await probe(db)).filter((f) => f.table === 'control');
    expect(failures.map((f) => `${f.statement} ${f.column ?? ''}`.trim()).sort()).toEqual([
      'DELETE',
      'INSERT',
      'UPDATE a',
      'UPDATE b',
    ]);
    expect(failures.every((f) => f.message.includes('later_column'))).toBe(true);
  });
});
