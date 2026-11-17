import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

type Master = { type: string; name: string; sql: string };

const schema = (db: D1Database) =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all<Master>()
    // _cf_* belongs to the D1 runtime, not to the migrations.
    .then((r) => r.results.filter((row) => !row.name.startsWith('_cf_')));

const tables = async (db: D1Database) => {
  const out: Record<string, unknown[]> = {};
  for (const { name } of (await schema(db)).filter((row) => row.type === 'table')) {
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    out[name] = rows.results.map((row) => {
      const { applied_at: _applied, ...rest } = row;
      return rest;
    });
  }
  return out;
};

// The worker setup applies tools/build-test-schema.ts output instead of the migrations.
it('the snapshot the setup applies equals the real migrations, schema and seed data', async () => {
  const real = (env as unknown as Record<string, D1Database>).KEYSET_TEST_DB_31 as D1Database;
  await applyD1Migrations(real, env.TEST_MIGRATIONS);
  expect(await schema(env.DB)).toEqual(await schema(real));
  expect(await tables(env.DB)).toEqual(await tables(real));
});
