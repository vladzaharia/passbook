import { CsvError, type CsvErrorCode, parseCsv } from '../csv/parse.ts';
import {
  checkHeader,
  TABULAR_LIMITS,
  TabularError,
  type TabularErrorCode,
  toRecords,
} from './limits.ts';

const CODES: Record<CsvErrorCode, TabularErrorCode> = {
  IMPORT_FILE_EMPTY: 'FILE_EMPTY',
  IMPORT_FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  IMPORT_TOO_MANY_ROWS: 'FILE_TOO_MANY_ROWS',
  IMPORT_NOT_CSV: 'FILE_FORMAT_UNSUPPORTED',
  IMPORT_ENCODING: 'FILE_ENCODING',
  IMPORT_HEADER_MISSING: 'FILE_HEADER_MISSING',
  IMPORT_HEADER_DUPLICATE: 'FILE_HEADER_DUPLICATE',
  IMPORT_TOO_MANY_COLUMNS: 'FILE_TOO_MANY_COLUMNS',
};

export interface CsvTable {
  columns: string[];
  /** Cells are strings, kept verbatim and never evaluated. Short rows are padded with ''. */
  records: Record<string, string>[];
}

/**
 * Delimiter-sniffed CSV through the shared parser, which also removes the export's formula
 * guard (`'=x` was `=x`; `guardCell` in `csv/write.ts` adds it again on every CSV we write).
 */
export function parseCsvTable(text: string): CsvTable {
  let parsed: ReturnType<typeof parseCsv>;
  try {
    parsed = parseCsv(text, {
      maxBytes: TABULAR_LIMITS.fileBytes,
      maxRows: TABULAR_LIMITS.rows,
      maxColumns: TABULAR_LIMITS.columns,
    });
  } catch (error) {
    if (error instanceof CsvError) throw new TabularError(CODES[error.code], error.message);
    throw error;
  }
  checkHeader(parsed.header);
  for (const { cells } of parsed.rows)
    if (cells.some((c) => c.length > TABULAR_LIMITS.cellChars))
      throw new TabularError('FILE_CELL_TOO_LONG', 'A cell has more than 2,000 characters.');
  return {
    columns: parsed.header,
    records: toRecords(
      parsed.header,
      parsed.rows.map((r) => r.cells),
      '',
    ),
  };
}
