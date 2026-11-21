import type { SqlValue } from '../../platform/db.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { importGrant } from './repo-imports.ts';

export interface RowInsert {
  row: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  passId: string | null;
  expectedVersion: number | null;
  externalId: string | null;
  holderEmail: string | null;
  input: string | null;
  problems: string | null;
}

export interface ImportRowRecord {
  row_no: number;
  action: RowInsert['action'];
  pass_id: string | null;
  expected_version: number | null;
  external_id: string | null;
  holder_email: string | null;
  input: string | null;
  problems: string | null;
  state: 'planned' | 'done' | 'failed' | 'skipped';
  result: 'created' | 'updated' | 'unchanged' | null;
  code: string | null;
  emailed: number;
  before: string | null;
}

/** Rows per grant, and per statement (a guarded insert binds at most 40 values: 8 columns, 4 rows). */
const PER_GRANT = 200;
const PER_STATEMENT = 4;
const COLUMNS = [
  'row_no',
  'action',
  'pass_id',
  'expected_version',
  'external_id',
  'holder_email',
  'input',
  'problems',
];

/** Writes the checked rows in grants of 200; the draft stays `checking` until `finishCheck`. */
export async function insertRows(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  id: string,
  checkId: string,
  rows: readonly RowInsert[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += PER_GRANT) {
    const g = importGrant(ctx, authority, id, { state: 'checking', check_id: checkId });
    const slice = rows.slice(i, i + PER_GRANT);
    for (let j = 0; j < slice.length; j += PER_STATEMENT)
      g.insertJoined('pass_import_rows', {
        parents: { import_id: id },
        columns: COLUMNS,
        rows: slice
          .slice(j, j + PER_STATEMENT)
          .map((r): SqlValue[] => [
            r.row,
            r.action,
            r.passId,
            r.expectedVersion,
            r.externalId,
            r.holderEmail,
            r.input,
            r.problems,
          ]),
      });
    await g.commit();
  }
}

const SELECT = `SELECT row_no, action, pass_id, expected_version, external_id, holder_email, input,
  problems, state, result, code, emailed, before FROM pass_import_rows`;

/** One page by row number: 100 and one more to know whether another page follows. */
export function pageRows(
  db: D1Database,
  importId: string,
  state: string | undefined,
  after: number,
  limit: number,
): Promise<ImportRowRecord[]> {
  return all<ImportRowRecord>(
    db,
    `${SELECT} WHERE import_id = ? AND row_no > ? ${state ? 'AND state = ?' : ''}
     ORDER BY row_no LIMIT ?`,
    [importId, after, ...(state ? [state] : []), limit],
  );
}

/** Rows that carry problems: rows with errors first, each group in file order. */
export function problemRows(
  db: D1Database,
  importId: string,
  limit: number,
): Promise<
  Pick<ImportRowRecord, 'row_no' | 'problems' | 'input' | 'external_id' | 'holder_email'>[]
> {
  return all(
    db,
    `SELECT row_no, problems, input, external_id, holder_email FROM pass_import_rows
     WHERE import_id = ? AND problems IS NOT NULL
     ORDER BY CASE action WHEN 'error' THEN 0 ELSE 1 END, row_no LIMIT ?`,
    [importId, limit],
  );
}

/** Rows with an error problem, for the error file. */
export function errorRows(
  db: D1Database,
  importId: string,
): Promise<Pick<ImportRowRecord, 'row_no' | 'problems'>[]> {
  return all(
    db,
    `SELECT row_no, problems FROM pass_import_rows
     WHERE import_id = ? AND action = 'error' ORDER BY row_no`,
    [importId],
  );
}

export function previewRows(
  db: D1Database,
  importId: string,
  limit: number,
): Promise<Pick<ImportRowRecord, 'row_no' | 'action' | 'input'>[]> {
  return all(
    db,
    `SELECT row_no, action, input FROM pass_import_rows
     WHERE import_id = ? AND action IN ('create', 'update') ORDER BY row_no LIMIT ?`,
    [importId, limit],
  );
}

/** Rows with errors, by what they would do once fixed: those that found a pass would update it. */
export async function errorIntents(
  db: D1Database,
  importId: string,
): Promise<{ create: number; update: number }> {
  const row = await first<{ n: number; found: number | null }>(
    db,
    `SELECT count(*) AS n, sum(pass_id IS NOT NULL) AS found FROM pass_import_rows
     WHERE import_id = ? AND action = 'error' AND input IS NOT NULL`,
    [importId],
  );
  const update = row?.found ?? 0;
  return { create: (row?.n ?? 0) - update, update };
}

export async function emailableCount(db: D1Database, importId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM pass_import_rows
     WHERE import_id = ? AND action = 'create' AND holder_email IS NOT NULL`,
    [importId],
  );
  return row?.n ?? 0;
}

/** Every problem of the draft by severity, not capped like the list. */
export async function problemTotals(
  db: D1Database,
  importId: string,
): Promise<{ errors: number; warnings: number }> {
  const rows = await all<{ severity: string; n: number }>(
    db,
    `SELECT json_extract(j.value, '$.severity') AS severity, count(*) AS n
     FROM pass_import_rows r, json_each(r.problems) j
     WHERE r.import_id = ? AND r.problems IS NOT NULL GROUP BY severity`,
    [importId],
  );
  const n = (s: string) => rows.find((r) => r.severity === s)?.n ?? 0;
  return { errors: n('error'), warnings: n('warning') };
}

export async function createdRowNumbers(db: D1Database, importId: string): Promise<number[]> {
  const rows = await all<{ row_no: number }>(
    db,
    "SELECT row_no FROM pass_import_rows WHERE import_id = ? AND result = 'created'",
    [importId],
  );
  return rows.map((r) => r.row_no);
}

/** The draft's counts as its rows stand now, for a re-check that rewrote only some of them. */
export async function rowCounts(
  db: D1Database,
  importId: string,
): Promise<{
  rows: number;
  create: number;
  update: number;
  unchanged: number;
  errors: number;
  warnings: number;
}> {
  const rows = await all<{ action: string; n: number }>(
    db,
    'SELECT action, count(*) AS n FROM pass_import_rows WHERE import_id = ? GROUP BY action',
    [importId],
  );
  const n = (a: string) => rows.find((r) => r.action === a)?.n ?? 0;
  return {
    rows: rows.reduce((t, r) => t + r.n, 0),
    create: n('create'),
    update: n('update'),
    unchanged: n('unchanged'),
    errors: n('error'),
    warnings: (await problemTotals(db, importId)).warnings,
  };
}
