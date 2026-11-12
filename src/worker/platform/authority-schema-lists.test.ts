// The constant table lists of authority-tables.ts must equal what the migrated schema says.
import { describe, expect, it } from 'vitest';
import { db } from './authority-ext-fixtures.ts';
import {
  APPEND_ONLY_TABLES,
  AUTHORITY_TABLES,
  GUARDED_TABLES,
  MODE_BEARING_TABLES,
  ORG_BEARING_TABLES,
  PASS_BEARING_TABLES,
  TRIGGER_WRITES_GUARDED,
} from './authority-tables.ts';
import { all } from './db.ts';

const skip = new Set<string>([
  ...Object.keys(GUARDED_TABLES),
  ...AUTHORITY_TABLES,
  ...APPEND_ONLY_TABLES,
]);

async function tablesWith(column: string): Promise<string[]> {
  const tables = await all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  );
  const out: string[] = [];
  for (const { name } of tables) {
    if (skip.has(name)) continue;
    const cols = await all<{ name: string }>(db, `SELECT name FROM pragma_table_info('${name}')`);
    if (cols.some((c) => c.name === column)) out.push(name);
  }
  return out.sort();
}

describe('schema-derived table lists', () => {
  it('ORG_BEARING_TABLES, MODE_BEARING_TABLES and PASS_BEARING_TABLES match the schema', async () => {
    expect(await tablesWith('org_id')).toEqual([...ORG_BEARING_TABLES].sort());
    expect(await tablesWith('mode')).toEqual([...MODE_BEARING_TABLES].sort());
    expect(await tablesWith('pass_id')).toEqual([...PASS_BEARING_TABLES].sort());
  });

  it('TRIGGER_WRITES_GUARDED lists every unguarded table whose triggers write a guarded table', async () => {
    const triggers = await all<{ tbl_name: string; sql: string }>(
      db,
      "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'",
    );
    const found = new Set<string>();
    for (const t of triggers) {
      if (t.tbl_name in GUARDED_TABLES || AUTHORITY_TABLES.includes(t.tbl_name as never)) continue;
      const body = t.sql.replace(/'(?:[^']|'')*'/g, "''");
      for (const g of Object.keys(GUARDED_TABLES))
        if (
          new RegExp(
            `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${g}\\b`,
            'i',
          ).test(body)
        )
          found.add(t.tbl_name);
    }
    expect([...found].sort()).toEqual([...TRIGGER_WRITES_GUARDED].sort());
  });

  it('every guarded table that names a pass declares the column', () => {
    expect(GUARDED_TABLES.member_photos?.pass).toBe('pass_id');
  });
});
