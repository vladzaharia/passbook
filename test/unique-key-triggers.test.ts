import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const GUARDS = {
  scanners: 'scanners_revision_no_replace_update',
  passes: 'pass_credential_no_replace_update',
} as const;

const words = (sql: string) => new Set(sql.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

/** Every column a UNIQUE index of the table keys on or filters by (expression and partial indexes included). */
async function keyColumns(table: string): Promise<Set<string>> {
  const columns = new Set(
    (
      await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()
    ).results.map((c) => c.name),
  );
  const out = new Set<string>();
  const indexes = await env.DB.prepare(
    `SELECT name, "unique" AS u FROM pragma_index_list('${table}')`,
  ).all<{ name: string; u: number }>();
  for (const index of indexes.results.filter((i) => i.u === 1)) {
    const info = await env.DB.prepare(`SELECT name FROM pragma_index_info('${index.name}')`).all<{
      name: string | null;
    }>();
    for (const c of info.results) if (c.name) out.add(c.name);
    const master = await env.DB.prepare('SELECT sql FROM sqlite_master WHERE name = ?')
      .bind(index.name)
      .first<{ sql: string | null }>();
    if (master?.sql) for (const w of words(master.sql)) if (columns.has(w)) out.add(w);
  }
  return out;
}

it('unique keys of scanners and passes are all in their no-replace trigger UPDATE OF list', async () => {
  for (const [table, trigger] of Object.entries(GUARDS)) {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    )
      .bind(trigger)
      .first<{ sql: string }>();
    const listed = /UPDATE OF ([^\n]*?) ON /.exec(row?.sql ?? '')?.[1];
    expect(listed, `${trigger} must be an UPDATE OF trigger`).toBeTruthy();
    const guarded = new Set((listed ?? '').split(',').map((c) => c.trim()));
    const keys = await keyColumns(table);
    expect(keys.size).toBeGreaterThan(0);
    const missing = [...keys].filter((c) => !guarded.has(c));
    expect(missing, `${table}: extend ${trigger} to cover a new unique key`).toEqual([]);
  }
});
