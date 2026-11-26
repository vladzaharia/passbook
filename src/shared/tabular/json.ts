import { detectRecordsArray } from '../records/detect.ts';
import { resolvePointer } from '../records/fields.ts';
import { checkHeader, TABULAR_LIMITS, TabularError } from './limits.ts';

export interface JsonTable {
  columns: string[];
  records: Record<string, unknown>[];
  /** The pointer records were read from ('' for a root array); unset for NDJSON. */
  recordsPointer?: string;
}

/** Deepest nesting of [ and { outside strings; stops early past the limit. */
function depthOf(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) max = depth;
      if (max > TABULAR_LIMITS.jsonDepth) return max;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

/** Parses one JSON document. Throws TabularError only. */
export function parseJsonDocument(text: string): unknown {
  if (depthOf(text) > TABULAR_LIMITS.jsonDepth)
    throw new TabularError('FILE_JSON_TOO_DEEP', 'The JSON is nested more than 32 levels.');
  try {
    return JSON.parse(text);
  } catch {
    throw new TabularError('FILE_DAMAGED', 'The JSON is not valid.');
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One object per line; blank lines are skipped. */
export function parseNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (
      line.length > TABULAR_LIMITS.ndjsonLineBytes ||
      (line.length > TABULAR_LIMITS.ndjsonLineBytes / 4 &&
        new TextEncoder().encode(line).length > TABULAR_LIMITS.ndjsonLineBytes)
    )
      throw new TabularError('FILE_LINE_TOO_LONG', 'A line is longer than 64 KB.');
    if (out.length >= TABULAR_LIMITS.rows)
      throw new TabularError('FILE_TOO_MANY_ROWS', `Use at most ${TABULAR_LIMITS.rows} rows.`);
    out.push(parseJsonDocument(line));
  }
  return out;
}

function table(items: unknown[], recordsPointer?: string): JsonTable {
  if (items.length === 0) throw new TabularError('FILE_EMPTY', 'The file has no records.');
  if (items.length > TABULAR_LIMITS.rows)
    throw new TabularError('FILE_TOO_MANY_ROWS', `Use at most ${TABULAR_LIMITS.rows} rows.`);
  const columns = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isPlain(item))
      throw new TabularError('FILE_NOT_RECORDS', 'Every record must be an object.');
    for (const k in item) {
      if (!Object.hasOwn(item, k)) continue;
      columns.add(k);
      if (columns.size > TABULAR_LIMITS.columns)
        throw new TabularError(
          'FILE_TOO_MANY_COLUMNS',
          `Use at most ${TABULAR_LIMITS.columns} columns.`,
        );
      const v = item[k];
      if (typeof v === 'string' && v.length > TABULAR_LIMITS.cellChars)
        throw new TabularError('FILE_CELL_TOO_LONG', 'A value has more than 2,000 characters.');
    }
    records.push(item);
  }
  const names = [...columns];
  if (names.some((n) => n === ''))
    throw new TabularError('FILE_HEADER_MISSING', 'Every field needs a name.');
  if (names.some((n) => n.length > TABULAR_LIMITS.headerChars)) checkHeader(names);
  return recordsPointer === undefined
    ? { columns: names, records }
    : { columns: names, records, recordsPointer };
}

export function ndjsonTable(items: unknown[]): JsonTable {
  return table(items);
}

/** Records of a JSON document: `pointer` when given, else the detected records array. */
export function jsonTable(root: unknown, pointer?: string): JsonTable {
  if (pointer !== undefined && pointer !== '') {
    if (!pointer.startsWith('/'))
      throw new TabularError('FILE_BAD_POINTER', 'The records path must start with /.');
    const hit = resolvePointer(root, pointer);
    if (!hit.found)
      throw new TabularError('FILE_RECORDS_NOT_FOUND', 'The records path is not in the file.');
    if (!Array.isArray(hit.value))
      throw new TabularError('FILE_NOT_RECORDS', 'The records path is not a list.');
    return table(hit.value, pointer);
  }
  if (pointer === '' || Array.isArray(root)) {
    if (!Array.isArray(root))
      throw new TabularError('FILE_NOT_RECORDS', 'The file is not a list of records.');
    return table(root, '');
  }
  const best = detectRecordsArray(root);
  if (!best)
    throw new TabularError('FILE_NOT_RECORDS', 'No list of records found. Set the records path.');
  const hit = resolvePointer(root, best.pointer);
  return table(hit.found && Array.isArray(hit.value) ? hit.value : [], best.pointer);
}
