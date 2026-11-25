import type { RestPagination } from '@/shared/contracts/connection-probe.ts';
import { escapeToken } from '@/shared/records/fields.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The flat config keys the explorer owns on top of the schema form. */
export const KEY = {
  path: 'list.path',
  records: 'list.recordsPointer',
  id: 'list.idPointer',
  pagination: 'list.pagination',
  incremental: 'list.incremental',
  email: 'holderEmailPointer',
} as const;
export const OWNED: string[] = [KEY.pagination, KEY.incremental];
/** Defaults of the schema; a value equal to one of these counts as untouched. */
export const DEFAULT_RECORDS = '/items';
export const DEFAULT_ID = '/id';

export type Style = RestPagination['style'];
export const STYLES: { value: Style; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'next-link', label: 'Next link' },
  { value: 'link-header', label: 'Link header' },
  { value: 'page', label: 'Page number' },
  { value: 'offset', label: 'Offset' },
];

export function readPagination(v: FormValues): RestPagination {
  const p = v[KEY.pagination];
  if (!isObj(p) || typeof p.style !== 'string') return { style: 'none' };
  return p as unknown as RestPagination;
}

/** A new style, keeping what the old one shares (the parameter name, the page size). */
export function paginationFor(style: Style, prev: RestPagination): RestPagination {
  const param = 'param' in prev ? prev.param : '';
  const size = 'size' in prev ? prev.size : undefined;
  const sizeParam = 'sizeParam' in prev ? prev.sizeParam : undefined;
  switch (style) {
    case 'cursor':
      return {
        style,
        param: style === prev.style ? param : 'cursor',
        cursorPointer: '',
        from: 'body',
      };
    case 'next-link':
      return { style, nextPointer: '' };
    case 'page':
      return {
        style,
        param: prev.style === 'offset' ? 'page' : param || 'page',
        start: 1,
        ...(sizeParam ? { sizeParam } : {}),
        ...(size ? { size } : {}),
      };
    case 'offset':
      return { style, param: 'offset', sizeParam: sizeParam ?? 'limit', size: size ?? 100 };
    default:
      return { style } as RestPagination;
  }
}

/** Field errors of the pagination block, keyed by the field. */
export function paginationErrors(p: RestPagination): Record<string, string> {
  const e: Record<string, string> = {};
  const name = /^[A-Za-z0-9_.$[\]-]{1,60}$/;
  if (p.style === 'cursor') {
    if (!name.test(p.param)) e.param = 'Name the query parameter.';
    if (p.from === 'body' && !p.cursorPointer) e.cursorPointer = 'Pick the cursor in the response.';
  }
  if (p.style === 'next-link' && !p.nextPointer)
    e.nextPointer = 'Pick the next link in the response.';
  if (p.style === 'page' && !name.test(p.param)) e.param = 'Name the query parameter.';
  if (p.style === 'offset') {
    if (!name.test(p.param)) e.param = 'Name the query parameter.';
    if (!name.test(p.sizeParam)) e.sizeParam = 'Name the query parameter.';
    if (!(p.size >= 1 && p.size <= 1000)) e.size = 'Whole number from 1 to 1000.';
  }
  return e;
}

export interface Incremental {
  param: string;
  field: string;
  format: 'iso' | 'unix' | 'unix-ms';
  overlapSeconds: number;
}

export function readIncremental(v: FormValues): Incremental | undefined {
  const i = v[KEY.incremental];
  if (!isObj(i)) return undefined;
  const format = i.format === 'unix' || i.format === 'unix-ms' ? i.format : 'iso';
  return {
    param: str(i.param),
    field: str(i.field),
    format,
    overlapSeconds: typeof i.overlapSeconds === 'number' ? i.overlapSeconds : 300,
  };
}

export function incrementalErrors(i: Incremental): Record<string, string> {
  const e: Record<string, string> = {};
  if (!/^[A-Za-z0-9_.$[\]-]{1,60}$/.test(i.param)) e.param = 'Name the query parameter.';
  if (!i.field) e.field = 'Pick the updated time in the response.';
  if (!(i.overlapSeconds >= 0 && i.overlapSeconds <= 86_400)) e.overlap = 'From 0 to 86400.';
  return e;
}

/** What blocks Next or Save: an unfinished pagination or incremental block. */
export function restErrors(v: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, m] of Object.entries(paginationErrors(readPagination(v))))
    out[`pagination.${k}`] = m;
  const inc = readIncremental(v);
  if (inc) for (const [k, m] of Object.entries(incrementalErrors(inc))) out[`incremental.${k}`] = m;
  return out;
}

/** The pointer of a node as the config stores it: inside a record it is relative to the record. */
export function relativeTo(records: string, pointer: string): string | null {
  const head = `${records}/`;
  if (!pointer.startsWith(head)) return null;
  const rest = pointer.slice(head.length);
  const slash = rest.indexOf('/');
  if (!/^\d+$/.test(slash < 0 ? rest : rest.slice(0, slash))) return null;
  return slash < 0 ? '' : rest.slice(slash);
}

export const child = (pointer: string, key: string) => `${pointer}/${escapeToken(key)}`;
