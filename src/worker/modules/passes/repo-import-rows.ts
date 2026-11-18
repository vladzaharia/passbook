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
  rows: readonly RowInsert[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += PER_GRANT) {
    const g = importGrant(ctx, authority, id, ['checking']);
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
  problems, state, result, code, emailed FROM pass_import_rows`;

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

/** Rows that carry problems, in file order. */
export function problemRows(
  db: D1Database,
  importId: string,
  limit: number,
): Promise<Pick<ImportRowRecord, 'row_no' | 'problems'>[]> {
  return all(
    db,
    `SELECT row_no, problems FROM pass_import_rows
     WHERE import_id = ? AND problems IS NOT NULL ORDER BY row_no LIMIT ?`,
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

export async function emailableCount(db: D1Database, importId: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM pass_import_rows
     WHERE import_id = ? AND action = 'create' AND holder_email IS NOT NULL`,
    [importId],
  );
  return row?.n ?? 0;
}
