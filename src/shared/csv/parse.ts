export type CsvErrorCode =
  | 'IMPORT_FILE_EMPTY'
  | 'IMPORT_FILE_TOO_LARGE'
  | 'IMPORT_TOO_MANY_ROWS'
  | 'IMPORT_NOT_CSV'
  | 'IMPORT_ENCODING'
  | 'IMPORT_HEADER_MISSING'
  | 'IMPORT_HEADER_DUPLICATE'
  | 'IMPORT_TOO_MANY_COLUMNS';

export class CsvError extends Error {
  readonly code: CsvErrorCode;
  constructor(code: CsvErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CsvError';
  }
}

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
}

export const CSV_LIMITS: CsvLimits = { maxBytes: 2_000_000, maxRows: 2000, maxColumns: 100 };

export interface ParsedCsv {
  delimiter: ',' | ';' | '\t';
  header: string[];
  /** Data rows without blank ones; `row` is the spreadsheet row, the header being row 1. */
  rows: { row: number; cells: string[] }[];
}

const DELIMITERS = [',', ';', '\t'] as const;

function decode(input: string | Uint8Array, maxBytes: number): string {
  let bytes: Uint8Array | null = null;
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    bytes = input;
    if (bytes.length > maxBytes)
      throw new CsvError('IMPORT_FILE_TOO_LARGE', 'The file is too large.');
    if (
      bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    ) {
      throw new CsvError('IMPORT_ENCODING', 'Save the file as UTF-8.');
    }
    // ZIP container: .xlsx, .ods, .zip.
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x50 &&
      bytes[1] === 0x4b &&
      (bytes[2] ?? 9) <= 0x08 &&
      (bytes[3] ?? 9) <= 0x08
    ) {
      throw new CsvError('IMPORT_NOT_CSV', 'Save the sheet as CSV first.');
    }
    // Legacy .xls: OLE compound file.
    if (
      bytes.length >= 4 &&
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0
    ) {
      throw new CsvError('IMPORT_NOT_CSV', 'Save the sheet as CSV first.');
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new CsvError('IMPORT_ENCODING', 'Save the file as UTF-8.');
    }
  }
  if (!bytes && (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes)) {
    throw new CsvError('IMPORT_FILE_TOO_LARGE', 'The file is too large.');
  }
  if (text.startsWith('PK\u0003\u0004')) {
    throw new CsvError('IMPORT_NOT_CSV', 'Save the sheet as CSV first.');
  }
  if (text.includes('\0')) throw new CsvError('IMPORT_NOT_CSV', 'This is not a CSV file.');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter that splits the header line (outside quotes) into most cells; comma on a tie. */
function detect(text: string): ParsedCsv['delimiter'] {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch !== undefined && ch in counts) counts[ch as keyof typeof counts]++;
  }
  return DELIMITERS.reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');
}

/** Inverse of the export guard: `'=x` was `=x`. */
const unguard = (v: string) => (/^'(?:[ \t\r\n]*[=+\-@]|[\t\r])/.test(v) ? v.slice(1) : v);

/** A row wider than this is refused while tokenising, whatever the caller's column limit. */
const HARD_COLUMNS = 1000;

function records(text: string, delimiter: string, maxRows: number, maxColumns: number): string[][] {
  const widest = Math.min(HARD_COLUMNS, Math.max(maxColumns * 10, 100));
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' && cell === '') {
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) throw new CsvError('IMPORT_NOT_CSV', 'A quote is not closed.');
        cell += text.slice(i, q);
        if (text[q + 1] === '"') {
          cell += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
    } else if (ch === delimiter) {
      row.push(cell);
      if (row.length > widest)
        throw new CsvError('IMPORT_TOO_MANY_COLUMNS', `Use at most ${maxColumns} columns.`);
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      out.push(row);
      // The header is row one; blank lines count here, so this is a ceiling, not the exact row cap.
      if (out.length > maxRows + 1)
        throw new CsvError('IMPORT_TOO_MANY_ROWS', `Use at most ${maxRows} rows.`);
      row = [];
      cell = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      // One slice per run: appending character by character builds a rope that costs ~35x the text.
      let end = i + 1;
      while (end < n) {
        const c = text[end];
        if (c === delimiter || c === '\n' || c === '\r') break;
        end++;
      }
      cell += text.slice(i, end);
      i = end;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

/**
 * RFC 4180: quoted newlines and quotes, CRLF or LF, BOM, a `,` `;` or tab delimiter, and the
 * export's formula guard removed. Throws CsvError for whole-file problems; row shape and cell
 * length are the caller's to check.
 */
export function parseCsv(input: string | Uint8Array, limits: Partial<CsvLimits> = {}): ParsedCsv {
  const { maxBytes, maxRows, maxColumns } = { ...CSV_LIMITS, ...limits };
  const text = decode(input, maxBytes);
  if (text.trim() === '') throw new CsvError('IMPORT_FILE_EMPTY', 'The file is empty.');
  const delimiter = detect(text);
  const all = records(text, delimiter, maxRows, maxColumns);
  const first = all[0] ?? [];
  const header = first.map((h) => unguard(h).trim());
  if (header.length > maxColumns) {
    throw new CsvError('IMPORT_TOO_MANY_COLUMNS', `Use at most ${maxColumns} columns.`);
  }
  if (header.some((h) => h === '')) {
    throw new CsvError('IMPORT_HEADER_MISSING', 'Every column needs a header.');
  }
  if (new Set(header).size !== header.length) {
    throw new CsvError('IMPORT_HEADER_DUPLICATE', 'Column headers must be unique.');
  }
  const rows: ParsedCsv['rows'] = [];
  for (let r = 1; r < all.length; r++) {
    const cells = all[r] as string[];
    if (cells.every((c) => c.trim() === '')) continue;
    if (rows.length >= maxRows) {
      throw new CsvError('IMPORT_TOO_MANY_ROWS', `Use at most ${maxRows} rows.`);
    }
    rows.push({ row: r + 1, cells: cells.map(unguard) });
  }
  return { delimiter, header, rows };
}
