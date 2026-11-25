import { child } from './rest-values.ts';

export type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface TreeRow {
  /** The JSON pointer; unique, so it is the row's id. */
  pointer: string;
  key: string;
  depth: number;
  kind: Kind;
  /** Scalars: the value, cut short. Containers: the count. */
  preview: string;
  count: number;
  /** The array's length before pruning, when the sample cut it. */
  total: number | undefined;
  expandable: boolean;
  parent: string | null;
  setSize: number;
  posInSet: number;
  /** An array whose items are objects: it can be the records. */
  records: boolean;
}

const kindOf = (v: unknown): Kind =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'object'
        ? 'object'
        : (typeof v as 'string' | 'number' | 'boolean');

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function entriesOf(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  return isObj(v) ? Object.entries(v) : [];
}

const PREVIEW = 48;

function previewOf(v: unknown, kind: Kind, count: number): string {
  if (kind === 'object') return `{} ${count}`;
  if (kind === 'array') return `[] ${count}`;
  if (kind === 'string') {
    const s = v as string;
    return `"${s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…` : s}"`;
  }
  return String(v);
}

/** Rows of the open nodes, depth first: what the tree shows and the keys walk. */
export function buildRows(
  body: unknown,
  open: ReadonlySet<string>,
  totals: ReadonlyMap<string, number>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (
    value: unknown,
    pointer: string,
    key: string,
    depth: number,
    parent: string | null,
    posInSet: number,
    setSize: number,
  ) => {
    const kind = kindOf(value);
    const kids = entriesOf(value);
    rows.push({
      pointer,
      key,
      depth,
      kind,
      preview: previewOf(value, kind, totals.get(pointer) ?? kids.length),
      count: kids.length,
      total: totals.get(pointer),
      expandable: kids.length > 0,
      parent,
      setSize,
      posInSet,
      records: kind === 'array' && kids.length > 0 && kids.every(([, x]) => isObj(x)),
    });
    if (kids.length === 0 || !open.has(pointer)) return;
    kids.forEach(([k, x], i) => {
      walk(x, child(pointer, k), k, depth + 1, pointer, i + 1, kids.length);
    });
  };
  walk(body, '', '$', 1, null, 1, 1);
  return rows;
}

/** Open: the root, the way to the records, and the first record. */
export function defaultOpen(records: string | undefined): Set<string> {
  const open = new Set<string>(['']);
  if (records === undefined) return open;
  let at = '';
  for (const token of records.split('/').slice(1)) {
    at = `${at}/${token}`;
    open.add(at);
  }
  open.add(`${records}/0`);
  return open;
}

/** The ways to a node, so a pick that is out of sight can open. */
export function ancestors(pointer: string): string[] {
  const out = [''];
  let at = '';
  for (const token of pointer.split('/').slice(1, -1)) {
    at = `${at}/${token}`;
    out.push(at);
  }
  return out;
}

export const rowLabel = (r: TreeRow): string => `${r.key}, ${r.preview}`;
