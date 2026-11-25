import type { z } from 'zod';
import {
  CONNECTION_FILE_LIMITS,
  type ConnectionFileColumnSchema,
  type ConnectionFileFormat,
} from '../../../shared/contracts/connection-files.ts';
import {
  escapeToken,
  ISO_DATE,
  ISO_DATETIME,
  resolvePointer,
} from '../../../shared/records/fields.ts';
import { type ParsedTable, parseTabular, TabularError } from '../../../shared/tabular/index.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { rejectFile } from './files-errors.ts';
import { storable } from './files-values.ts';

type Column = z.infer<typeof ConnectionFileColumnSchema>;

const CELL_PREVIEW = 80;
const PREVIEW_ROWS = 20;
/** Rows read to guess a column's kind; counts and samples cover every row. */
const TYPE_SAMPLE = 500;
const ID_NAMES = ['id', 'member id', 'ticket', 'code', 'number'];
export const REF_MAX = 200;
export const PAGE_SIZE = 200;

/** Bytes of an upload: `utf8` text or `base64`. Refuses a file over the limit before decoding it all. */
export function decodeContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  const limit = CONNECTION_FILE_LIMITS.bytes;
  const tooLarge = new TabularError('FILE_TOO_LARGE', 'Files can be up to 5 MB.');
  if (encoding === 'utf8') {
    const bytes = new TextEncoder().encode(content);
    if (bytes.length > limit) throw tooLarge;
    return bytes;
  }
  if (Math.floor((content.length * 3) / 4) > limit + 3) throw tooLarge;
  let binary: string;
  try {
    binary = atob(content);
  } catch {
    throw new TabularError('FILE_DAMAGED', 'The file could not be read.');
  }
  if (binary.length > limit) throw tooLarge;
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ParsedFile {
  format: ConnectionFileFormat;
  columns: string[];
  records: Record<string, unknown>[];
  sheets: string[];
  sheet: string | null;
  recordsPointer: string | null;
}

/** Parses and copies the rows for storage, in the org's zone. Throws only AppErrors. */
export function parseFile(
  ctx: ServiceContext,
  orgId: string,
  bytes: Uint8Array,
  options: { sheet?: string | undefined; recordsPointer?: string | undefined },
  zone: string,
): ParsedFile {
  let table: ParsedTable;
  let records: Record<string, unknown>[];
  try {
    table = parseTabular(bytes, {
      ...(options.sheet === undefined ? {} : { sheet: options.sheet }),
      ...(options.recordsPointer === undefined ? {} : { recordsPointer: options.recordsPointer }),
    });
    records = table.records.map((r) => storable(r, zone) as Record<string, unknown>);
  } catch (error) {
    return rejectFile(ctx, orgId, error);
  }
  return {
    format: table.format,
    columns: table.columns,
    records,
    sheets: table.sheets ?? [],
    sheet: table.sheet ?? null,
    recordsPointer: table.recordsPointer ?? null,
  };
}

export const pointerOf = (label: string): string => `/${escapeToken(label)}`;

const own = (record: Record<string, unknown>, label: string): unknown =>
  Object.hasOwn(record, label) ? record[label] : undefined;
const blank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);

function kindOf(values: unknown[]): Column['type'] {
  if (values.length === 0) return 'text';
  const kinds = new Set<Column['type']>(
    values.map((v) => {
      if (Array.isArray(v)) return 'list';
      if (typeof v === 'number') return 'number';
      if (typeof v === 'boolean') return 'boolean';
      if (typeof v !== 'string') return 'text';
      if (ISO_DATE.test(v) || ISO_DATETIME.test(v)) return 'date';
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
      if (/^https?:\/\/\S+$/i.test(v)) return 'url';
      return 'text';
    }),
  );
  return kinds.size === 1 ? ([...kinds][0] as Column['type']) : 'text';
}

/** One entry per column: kind, three samples, blank and repeated values over every row. */
export function describeColumns(file: ParsedFile): Column[] {
  return file.columns.map((label) => {
    const seen = new Set<string>();
    const samples: string[] = [];
    const typed: unknown[] = [];
    let blanks = 0;
    let duplicates = 0;
    file.records.forEach((record, i) => {
      const v = own(record, label);
      if (blank(v)) {
        blanks++;
        return;
      }
      const t = text(v);
      if (seen.has(t)) duplicates++;
      else {
        seen.add(t);
        if (samples.length < 3) samples.push(t.slice(0, CELL_PREVIEW));
      }
      if (i < TYPE_SAMPLE) typed.push(v);
    });
    return { pointer: pointerOf(label), label, type: kindOf(typed), samples, blanks, duplicates };
  });
}

/** Columns that could name each row: unique and filled first, then by how like an ID the name is. */
export function idCandidatesOf(columns: Column[], rows: number): string[] {
  const rank = (c: Column): number => {
    const name = c.label.toLowerCase().replace(/[_-]+/g, ' ').trim();
    const at = ID_NAMES.indexOf(name);
    return at >= 0
      ? at
      : ID_NAMES.some((n) => name.includes(n))
        ? ID_NAMES.length
        : ID_NAMES.length + 1;
  };
  return columns
    .map((c, i) => ({ c, i, ok: c.blanks === 0 && c.duplicates === 0 ? 0 : 1 }))
    .filter(({ c }) => c.blanks < rows)
    .sort((a, b) => a.ok - b.ok || rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c.pointer);
}

/** The header and the first rows, each cell cut short. */
export function previewOf(file: ParsedFile): { header: string[]; rows: string[][] } {
  return {
    header: file.columns,
    rows: file.records.slice(0, PREVIEW_ROWS).map((r) =>
      file.columns.map((label) => {
        const v = own(r, label);
        return blank(v) ? '' : text(v).slice(0, CELL_PREVIEW);
      }),
    ),
  };
}

export interface Entry {
  ref: string;
  record: Record<string, unknown>;
}

/** Rows keyed by the ID column, in file order. A row with no usable ID, or an ID already seen, is skipped. */
export function entriesOf(
  records: readonly Record<string, unknown>[],
  idPointer: string,
): { entries: Entry[]; noId: number; duplicate: number } {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let noId = 0;
  let duplicate = 0;
  for (const record of records) {
    const hit = resolvePointer(record, idPointer);
    const v = hit.found ? hit.value : undefined;
    const ref =
      typeof v === 'string'
        ? v.trim()
        : typeof v === 'number' && Number.isFinite(v)
          ? String(v)
          : '';
    if (ref === '' || ref.length > REF_MAX) noId++;
    else if (seen.has(ref)) duplicate++;
    else {
      seen.add(ref);
      entries.push({ ref, record });
    }
  }
  return { entries, noId, duplicate };
}

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : typeof v === 'object' && v !== null
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : (JSON.stringify(v) ?? 'null');

/** 16 hex of the SHA-256 of the record with its keys sorted. */
export async function digestOf(record: Record<string, unknown>): Promise<string> {
  return (await sha256Hex(new TextEncoder().encode(canonical(record)))).slice(0, 16);
}
