export const TABULAR_LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  rows: 10_000,
  columns: 100,
  cellChars: 2000,
  headerChars: 200,
  jsonDepth: 32,
  ndjsonLineBytes: 64 * 1024,
  xlsx: {
    entries: 200,
    totalBytes: 32 * 1024 * 1024,
    sheetBytes: 24 * 1024 * 1024,
    ratio: 100,
    ratioFloor: 64 * 1024,
    cells: 500_000,
    sharedStrings: 100_000,
    xmlDepth: 64,
    xmlTagChars: 8192,
  },
} as const;

export type TabularErrorCode =
  | 'FILE_FORMAT_UNSUPPORTED'
  | 'FILE_MACRO'
  | 'FILE_ENCODING'
  | 'FILE_EMPTY'
  | 'FILE_DAMAGED'
  | 'FILE_TOO_LARGE'
  | 'FILE_ARCHIVE_LIMIT'
  | 'FILE_XML_UNSAFE'
  | 'FILE_TOO_MANY_ROWS'
  | 'FILE_TOO_MANY_COLUMNS'
  | 'FILE_TOO_MANY_CELLS'
  | 'FILE_CELL_TOO_LONG'
  | 'FILE_LINE_TOO_LONG'
  | 'FILE_HEADER_MISSING'
  | 'FILE_HEADER_TOO_LONG'
  | 'FILE_HEADER_DUPLICATE'
  | 'FILE_ROW_SHAPE'
  | 'FILE_SHEET_NOT_FOUND'
  | 'FILE_JSON_TOO_DEEP'
  | 'FILE_NOT_RECORDS'
  | 'FILE_RECORDS_NOT_FOUND'
  | 'FILE_BAD_POINTER';

/** The only error the parsers throw. Messages are one sentence and carry no file content. */
export class TabularError extends Error {
  readonly code: TabularErrorCode;
  constructor(code: TabularErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TabularError';
    this.code = code;
  }
}

/** Header cells are trimmed strings, non-empty, at most 200 characters, unique. */
export function checkHeader(header: readonly string[]): void {
  if (header.length > TABULAR_LIMITS.columns)
    throw new TabularError(
      'FILE_TOO_MANY_COLUMNS',
      `Use at most ${TABULAR_LIMITS.columns} columns.`,
    );
  if (header.some((h) => h === ''))
    throw new TabularError('FILE_HEADER_MISSING', 'Every column needs a header.');
  if (header.some((h) => h.length > TABULAR_LIMITS.headerChars))
    throw new TabularError('FILE_HEADER_TOO_LONG', 'Headers can have at most 200 characters.');
  if (new Set(header).size !== header.length)
    throw new TabularError('FILE_HEADER_DUPLICATE', 'Column headers must be unique.');
}

/** Rows of cells to records keyed by header. `fromEntries` keeps a `__proto__` header an own key. */
export function toRecords<T>(
  header: readonly string[],
  rows: readonly (readonly T[])[],
  empty: T,
): Record<string, T>[] {
  if (rows.length > TABULAR_LIMITS.rows)
    throw new TabularError('FILE_TOO_MANY_ROWS', `Use at most ${TABULAR_LIMITS.rows} rows.`);
  if (rows.length === 0) throw new TabularError('FILE_EMPTY', 'The file has no data rows.');
  return rows.map((cells) => {
    if (cells.length > header.length && cells.slice(header.length).some((c) => c !== empty))
      throw new TabularError('FILE_ROW_SHAPE', 'A row has more cells than the header.');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? empty]));
  });
}
