import { TABULAR_LIMITS, TabularError } from './limits.ts';
import { parseXml } from './xlsx-xml.ts';

export type XlsxValue = string | number | boolean | null;

/** How a number format shows a serial: a date, a date and time, a time of day, or elapsed time. */
export type DateKind = 'date' | 'datetime' | 'time' | 'elapsed';

const BUILT_IN: Record<number, DateKind> = {
  14: 'date',
  15: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'datetime',
  45: 'time',
  46: 'elapsed',
  47: 'time',
};

/** Date kind of a custom format code, or null for a number format. */
export function classifyFormat(code: string): DateKind | null {
  // First section only; drop quoted text, escapes, padding and bracket parts (keeping [h] [m] [s]).
  const section = code.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0] ?? '';
  let elapsed = false;
  const bare = section
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
      if (/^(h+|m+|s+)$/i.test(inner)) elapsed = true;
      return '';
    })
    .toLowerCase();
  if (/^general$/.test(bare.trim())) return null;
  const hasTime = /[hs]/.test(bare);
  const hasDate = /[dy]/.test(bare) || (/m/.test(bare) && !hasTime);
  if (elapsed) return 'elapsed';
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

/** Per cell-style index: the date kind of its number format, or null. */
export function parseStyles(bytes: Uint8Array | undefined): (DateKind | null)[] {
  if (!bytes) return [];
  const custom = new Map<number, DateKind | null>();
  const xfs: (DateKind | null)[] = [];
  let inCellXfs = false;
  parseXml(bytes, {
    open(name, a) {
      if (name === 'numFmt') custom.set(Number(a.numFmtId), classifyFormat(a.formatCode ?? ''));
      else if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'xf' && inCellXfs) {
        const id = Number(a.numFmtId ?? 0);
        xfs.push(custom.has(id) ? (custom.get(id) ?? null) : (BUILT_IN[id] ?? null));
      }
    },
    text() {},
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return xfs;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Excel serial to `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` (no zone), or `HH:mm:ss` for a time of
 * day. Values with no real date stay numbers: negative, the 1900 leap-year ghost (60), day 0,
 * and anything past 9999-12-31. Elapsed-time formats stay numbers.
 */
export function serialToValue(serial: number, kind: DateKind, date1904: boolean): string | number {
  if (kind === 'elapsed' || !Number.isFinite(serial) || serial < 0 || serial >= 2958466)
    return serial;
  let day = Math.floor(serial);
  let secs = Math.round((serial - day) * 86400);
  if (secs === 86400) {
    day += 1;
    secs = 0;
  }
  const hh = pad(Math.floor(secs / 3600));
  const mi = pad(Math.floor((secs % 3600) / 60));
  const ss = pad(secs % 60);
  if (kind === 'time' && day === 0) return `${hh}:${mi}:${ss}`;
  // Days since 1970-01-01. The 1900 system counts a nonexistent 1900-02-29 as day 60.
  let days: number;
  if (date1904) days = day - 24107;
  else if (day === 60 || day === 0) return serial;
  else days = day < 60 ? day - 25568 : day - 25569;
  const d = new Date(days * 86400000);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return serial;
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return kind === 'date' || (secs === 0 && kind !== 'datetime' && kind !== 'time')
    ? date
    : `${date}T${hh}:${mi}:${ss}`;
}

/** Column letters to a zero-based index (A is 0); -1 when the reference is not a cell. */
export function columnIndex(ref: string): number {
  const m = /^([A-Za-z]{1,3})\d*$/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of (m[1] as string).toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n <= 16384 ? n - 1 : -1;
}

const damaged = () => new TabularError('FILE_DAMAGED', 'The spreadsheet is damaged.');
const tooMany = () =>
  new TabularError('FILE_TOO_MANY_CELLS', 'The spreadsheet has too many cells or strings.');
const MAX_TEXT = 100_000;

/** Shared strings in order; phonetic runs (`rPh`) are left out. */
export function parseSharedStrings(bytes: Uint8Array | undefined): string[] {
  const out: string[] = [];
  if (!bytes) return out;
  let buf = '';
  let capture = false;
  let phonetic = 0;
  parseXml(bytes, {
    open(name) {
      if (name === 'si') buf = '';
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && phonetic === 0) capture = true;
    },
    text(t) {
      if (capture && buf.length < MAX_TEXT) buf += t;
    },
    close(name) {
      if (name === 't') capture = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'si') {
        if (out.length >= TABULAR_LIMITS.xlsx.sharedStrings) throw tooMany();
        out.push(buf);
      }
    },
  });
  return out;
}

export interface SheetRows {
  /** Non-empty rows in file order, each a dense array that stops at its last filled cell. */
  rows: XlsxValue[][];
}

/**
 * Reads one worksheet. Formula cells give their cached value; error cells are empty; merged
 * ranges are ignored (the value stays in the top-left cell). Cells past column 100 must be empty.
 */
export function parseSheet(
  bytes: Uint8Array,
  shared: readonly string[],
  styles: readonly (DateKind | null)[],
  date1904: boolean,
): SheetRows {
  const rows: XlsxValue[][] = [];
  let row: XlsxValue[] = [];
  let col = -1;
  let type = '';
  let kind: DateKind | null = null;
  let v = '';
  let inline = '';
  let capture: 'v' | 'is' | null = null;
  let inIs = false;
  let phonetic = 0;
  let cells = 0;
  parseXml(bytes, {
    open(name, a) {
      if (name === 'row') {
        row = [];
        col = -1;
      } else if (name === 'c') {
        if (++cells > TABULAR_LIMITS.xlsx.cells) throw tooMany();
        const at = a.r === undefined ? col + 1 : columnIndex(a.r);
        if (at < 0) throw damaged();
        col = at;
        type = a.t ?? '';
        kind = a.s === undefined ? null : (styles[Number(a.s)] ?? null);
        v = '';
        inline = '';
      } else if (name === 'v') capture = 'v';
      else if (name === 'is') inIs = true;
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && inIs && phonetic === 0) capture = 'is';
    },
    text(t) {
      if (capture === 'v' && v.length < MAX_TEXT) v += t;
      else if (capture === 'is' && inline.length < MAX_TEXT) inline += t;
    },
    close(name) {
      if (name === 'v' || name === 't') capture = null;
      else if (name === 'is') inIs = false;
      else if (name === 'rPh') phonetic--;
      else if (name === 'c') {
        const value = cellValue(type, v, inline, kind, shared, date1904);
        if (value === null) return;
        if (col >= TABULAR_LIMITS.columns)
          throw new TabularError(
            'FILE_TOO_MANY_COLUMNS',
            `Use at most ${TABULAR_LIMITS.columns} columns.`,
          );
        if (typeof value === 'string' && value.length > TABULAR_LIMITS.cellChars)
          throw new TabularError('FILE_CELL_TOO_LONG', 'A cell has more than 2,000 characters.');
        while (row.length < col) row.push(null);
        row[col] = value;
      } else if (name === 'row') {
        if (row.some((c) => c !== null)) rows.push(row);
      }
    },
  });
  return { rows };
}

function cellValue(
  type: string,
  v: string,
  inline: string,
  kind: DateKind | null,
  shared: readonly string[],
  date1904: boolean,
): XlsxValue {
  const text = (s: string | undefined): XlsxValue => (s === undefined || s === '' ? null : s);
  switch (type) {
    case 's': {
      if (!/^\d+$/.test(v.trim())) throw damaged();
      const s = shared[Number(v)];
      if (s === undefined) throw damaged();
      return text(s);
    }
    case 'inlineStr':
      return text(inline);
    case 'str':
    case 'd':
      return text(v);
    case 'b':
      return v === '' ? null : v.trim() === '1' || v.trim().toLowerCase() === 'true';
    case 'e':
      return null;
    default: {
      if (inline !== '') return inline;
      if (v.trim() === '') return null;
      const n = Number(v);
      if (Number.isNaN(n)) return v;
      return kind ? serialToValue(n, kind, date1904) : n;
    }
  }
}
