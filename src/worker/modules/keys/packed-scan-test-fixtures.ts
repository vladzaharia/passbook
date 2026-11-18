import { all } from '../../platform/db.ts';

/** Columns that hold a packed envelope on purpose (sandbox/captured-body.ts). */
const REGISTERED = new Set(['captured_emails.html', 'captured_emails.text']);

/**
 * Every TEXT or BLOB column, outside the registry, that holds a value shaped like a packed envelope
 * (`enc1:` as captured emails keep it, `sc1.` as scan cursors do). An envelope kept somewhere the rewrap
 * does not look would stop opening the day its KEK is deleted.
 */
export async function packedEnvelopeColumns(db: D1Database): Promise<string[]> {
  const tables = await all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  );
  const found: string[] = [];
  for (const { name } of tables) {
    const columns = await all<{ name: string; type: string }>(db, `PRAGMA table_info("${name}")`);
    for (const column of columns) {
      if (REGISTERED.has(`${name}.${column.name}`)) continue;
      if (!/^(TEXT|BLOB|CHAR|CLOB|)/i.test(column.type)) continue;
      const hit = await all<{ x: number }>(
        db,
        `SELECT 1 AS x FROM "${name}" WHERE CAST("${column.name}" AS TEXT) GLOB 'enc1:*' OR CAST("${column.name}" AS TEXT) GLOB 'sc1.*' LIMIT 1`,
      );
      if (hit.length > 0) found.push(`${name}.${column.name}`);
    }
  }
  return found;
}
