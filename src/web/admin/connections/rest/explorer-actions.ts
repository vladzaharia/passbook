import type { RestPagination } from '@/shared/contracts/connection-probe.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import { KEY, paginationFor, readPagination, relativeTo } from './rest-values.ts';
import type { TreeRow } from './tree-model.ts';

export type Format = 'iso' | 'unix' | 'unix-ms';

/** What picking a node does. `updated` is held by the explorer until "Only fetch changes" is on. */
export interface Effect {
  patch?: FormValues;
  updated?: { field: string; format: Format };
}

export interface NodeAction {
  id: string;
  label: string;
  /** Said to a screen reader when it is done. */
  said: string;
  effect: Effect;
}

export function formatOf(row: TreeRow): Format {
  if (row.kind === 'number') return Number(row.preview) > 1e11 ? 'unix-ms' : 'unix';
  return 'iso';
}

const path = (p: string) => (p === '' ? 'whole body' : p);

type Cursor = Extract<RestPagination, { style: 'cursor' }>;

function cursorAt(v: FormValues, pointer: string, more?: boolean): RestPagination {
  const prev = readPagination(v);
  const base: Cursor = prev.style === 'cursor' ? prev : (paginationFor('cursor', prev) as Cursor);
  return more
    ? { ...base, hasMorePointer: pointer }
    : { ...base, from: 'body', cursorPointer: pointer };
}

/** The actions a node offers, by where it sits: the records, a field of a record, or elsewhere. */
export function actionsFor(row: TreeRow, records: string, v: FormValues): NodeAction[] {
  const set = (k: string, value: unknown) => ({ patch: { [k]: value } });
  if (row.records) {
    return [
      {
        id: 'records',
        label: 'Use as records',
        said: `Records: ${row.key}, ${row.count} items`,
        effect: set(KEY.records, row.pointer),
      },
    ];
  }
  if (row.kind === 'object' || row.kind === 'array') return [];
  const rel = relativeTo(records, row.pointer);
  if (rel !== null) {
    return [
      { id: 'id', label: 'Use as ID', said: `ID: ${path(rel)}`, effect: set(KEY.id, rel) },
      {
        id: 'updated',
        label: 'Use as updated time',
        said: `Updated: ${path(rel)}`,
        effect: { updated: { field: rel, format: formatOf(row) } },
      },
      {
        id: 'email',
        label: 'Use as holder email',
        said: `Holder email: ${path(rel)}`,
        effect: set(KEY.email, rel),
      },
    ];
  }
  const p = readPagination(v);
  const out: NodeAction[] = [
    {
      id: 'cursor',
      label: 'Use as next cursor',
      said: `Next cursor: ${row.key}`,
      effect: set(KEY.pagination, cursorAt(v, row.pointer)),
    },
    {
      id: 'next-link',
      label: 'Use as next link',
      said: `Next link: ${row.key}`,
      effect: set(KEY.pagination, { style: 'next-link', nextPointer: row.pointer }),
    },
  ];
  if (row.kind === 'boolean') {
    out.push({
      id: 'has-more',
      label: 'Use as has-more flag',
      said: `Has-more flag: ${row.key}`,
      effect: set(KEY.pagination, cursorAt(v, row.pointer, true)),
    });
  }
  if (row.kind === 'number') {
    const offset = p.style === 'offset';
    const next: RestPagination = offset
      ? { ...p, totalPointer: row.pointer }
      : ({
          ...(p.style === 'page' ? p : paginationFor('page', p)),
          totalPagesPointer: row.pointer,
        } as RestPagination);
    out.push({
      id: 'total',
      label: offset ? 'Use as total' : 'Use as total pages',
      said: `Total: ${row.key}`,
      effect: set(KEY.pagination, next),
    });
  }
  return out;
}

/** On the single record a pick can only be the holder email, relative to where the record starts. */
export function recordActions(row: TreeRow, recordAt: string): NodeAction[] {
  if (row.kind === 'object' || row.kind === 'array') return [];
  if (!row.pointer.startsWith(recordAt)) return [];
  const rel = row.pointer.slice(recordAt.length);
  return [
    {
      id: 'email',
      label: 'Use as holder email',
      said: `Holder email: ${path(rel)}`,
      effect: { patch: { [KEY.email]: rel } },
    },
  ];
}
