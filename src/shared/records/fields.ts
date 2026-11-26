export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'array'
  | 'mixed'
  | 'null';

export interface FieldInfo {
  /** RFC 6901 pointer from the record root. */
  pointer: string;
  /** The last path segment. */
  name: string;
  type: FieldType;
  /** Records in the sample with a non-empty value here. */
  filled: number;
  /** Records sampled. */
  total: number;
  distinct: number;
  /** Every sampled record has a value and no two share one. */
  unique: boolean;
  numMin?: number;
  numMax?: number;
  /** Up to 3 distinct values, cut to 40 characters. */
  samples: string[];
}

export interface FieldOptions {
  sample?: number;
  maxDepth?: number;
  maxFields?: number;
}

export const escapeToken = (t: string) => t.replace(/~/g, '~0').replace(/\//g, '~1');
export const unescapeToken = (t: string) => t.replace(/~1/g, '/').replace(/~0/g, '~');

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Acc {
  pointer: string;
  name: string;
  values: unknown[];
}

function flatten(
  value: unknown,
  pointer: string,
  depth: number,
  maxDepth: number,
  into: Map<string, unknown>,
): void {
  if (isPlain(value) && depth < maxDepth) {
    for (const [k, v] of Object.entries(value))
      flatten(v, `${pointer}/${escapeToken(k)}`, depth + 1, maxDepth, into);
    return;
  }
  into.set(pointer, value);
}

function typeOf(values: unknown[]): FieldType {
  if (values.length === 0) return 'null';
  const kinds = new Set<string>();
  for (const v of values) {
    if (Array.isArray(v)) kinds.add('array');
    else if (typeof v === 'string')
      kinds.add(ISO_DATE.test(v) ? 'date' : ISO_DATETIME.test(v) ? 'datetime' : 'string');
    else if (typeof v === 'number' || typeof v === 'boolean') kinds.add(typeof v);
    else kinds.add('mixed');
  }
  if (kinds.size === 1) return [...kinds][0] as FieldType;
  if (kinds.size === 2 && kinds.has('date') && kinds.has('datetime')) return 'datetime';
  return 'mixed';
}

/**
 * Leaf fields of the first `sample` records. Nested objects become pointers (`/user/email`);
 * arrays are leaves. Null and '' count as empty.
 */
export function leafFields(records: readonly unknown[], options: FieldOptions = {}): FieldInfo[] {
  const { sample = 500, maxDepth = 4, maxFields = 200 } = options;
  const rows = records.slice(0, sample);
  const accs = new Map<string, Acc>();
  for (const record of rows) {
    if (!isPlain(record)) continue;
    const flat = new Map<string, unknown>();
    flatten(record, '', 0, maxDepth, flat);
    for (const [pointer, v] of flat) {
      let acc = accs.get(pointer);
      if (!acc) {
        if (accs.size >= maxFields) continue;
        const name = unescapeToken(pointer.slice(pointer.lastIndexOf('/') + 1));
        acc = { pointer, name, values: [] };
        accs.set(pointer, acc);
      }
      if (v !== null && v !== undefined && v !== '') acc.values.push(v);
    }
  }
  return [...accs.values()].map((a) => {
    const texts = a.values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    const distinctSet = new Set(texts);
    const nums = a.values.filter((v): v is number => typeof v === 'number');
    const info: FieldInfo = {
      pointer: a.pointer,
      name: a.name,
      type: typeOf(a.values),
      filled: a.values.length,
      total: rows.length,
      distinct: distinctSet.size,
      unique:
        rows.length > 0 && a.values.length === rows.length && distinctSet.size === rows.length,
      samples: [...distinctSet].slice(0, 3).map((s) => s.slice(0, 40)),
    };
    if (nums.length === a.values.length && nums.length > 0) {
      info.numMin = Math.min(...nums);
      info.numMax = Math.max(...nums);
    }
    return info;
  });
}

/** Value at an RFC 6901 pointer; `found` is false when any step is missing. */
export function resolvePointer(
  root: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  if (pointer === '') return { found: true, value: root };
  if (!pointer.startsWith('/')) return { found: false };
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = unescapeToken(raw);
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= cur.length) return { found: false };
      cur = cur[Number(key)];
    } else if (isPlain(cur) && Object.hasOwn(cur, key)) {
      cur = cur[key];
    } else return { found: false };
  }
  return { found: true, value: cur };
}
