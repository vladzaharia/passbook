import { all } from '../../platform/db.ts';
import type { PlaceTable } from './rewrap-tables.ts';

const CAPTURE_OLDER = `(t.html GLOB 'enc1:*' AND CAST(substr(t.html, 6, instr(t.html, '.') - 6) AS INTEGER) < ?)
  OR (t.text GLOB 'enc1:*' AND CAST(substr(t.text, 6, instr(t.text, '.') - 6) AS INTEGER) < ?)`;

/** Whether any row of `table` is still under a KEK older than `current` (one row at most is read). */
export async function hasOlderEnvelope(
  db: D1Database,
  table: PlaceTable | 'captured_emails',
  current: number,
): Promise<boolean> {
  const row =
    table === 'captured_emails'
      ? await all(db, `SELECT 1 AS x FROM captured_emails t WHERE ${CAPTURE_OLDER} LIMIT 1`, [
          current,
          current,
        ])
      : await all(db, `SELECT 1 AS x FROM ${table} WHERE kek_version < ? LIMIT 1`, [current]);
  return row.length > 0;
}

/** Rows (columns, for captured emails) of `table` per KEK version older than `current`. */
export async function countOlderEnvelopes(
  db: D1Database,
  table: PlaceTable | 'captured_emails',
  current: number,
): Promise<{ v: number; n: number }[]> {
  return table === 'captured_emails'
    ? all<{ v: number; n: number }>(
        db,
        `SELECT v, count(*) AS n FROM (
           SELECT CAST(substr(t.html, 6, instr(t.html, '.') - 6) AS INTEGER) AS v FROM captured_emails t WHERE t.html GLOB 'enc1:*'
           UNION ALL
           SELECT CAST(substr(t.text, 6, instr(t.text, '.') - 6) AS INTEGER) AS v FROM captured_emails t WHERE t.text GLOB 'enc1:*')
         WHERE v < ? GROUP BY v`,
        [current],
      )
    : all<{ v: number; n: number }>(
        db,
        `SELECT kek_version AS v, count(*) AS n FROM ${table} WHERE kek_version < ? GROUP BY kek_version`,
        [current],
      );
}
