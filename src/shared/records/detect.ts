import { escapeToken, type FieldInfo } from './fields.ts';

export interface ArrayCandidate {
  pointer: string;
  length: number;
  /** The key name suggests a record list (data, items, results ...). */
  hinted: boolean;
  /** Object levels below the root. */
  depth: number;
}

const LIST_NAMES =
  /^(data|items|results?|records?|rows|entries|list|objects|members|users|customers|contacts|orders|tickets|attendees|passes|hits|values)$/i;
const MAX_DEPTH = 3;
const MAX_NODES = 5000;
const SAMPLE = 20;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isRecordList = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) && v.length > 0 && v.slice(0, SAMPLE).every(isPlain);

/**
 * Arrays of objects in a JSON document, best first: a root array, else name hint, then length,
 * then shallowness. Looks through objects only, 3 levels deep, and never into arrays.
 */
export function detectRecordsArrays(root: unknown): ArrayCandidate[] {
  const found: ArrayCandidate[] = [];
  let nodes = 0;
  const walk = (value: unknown, pointer: string, key: string, depth: number) => {
    if (++nodes > MAX_NODES) return;
    if (isRecordList(value)) {
      found.push({
        pointer,
        length: value.length,
        hinted: depth === 0 || LIST_NAMES.test(key),
        depth,
      });
      return;
    }
    if (!isPlain(value) || depth >= MAX_DEPTH) return;
    // for...in with a budget: Object.entries would allocate every pair of a huge object first.
    for (const k in value) {
      if (!Object.hasOwn(value, k)) continue;
      if (nodes > MAX_NODES) return;
      walk(value[k], `${pointer}/${escapeToken(k)}`, k, depth + 1);
    }
  };
  walk(root, '', '', 0);
  return found.sort(
    (a, b) => Number(b.hinted) - Number(a.hinted) || b.length - a.length || a.depth - b.depth,
  );
}

export function detectRecordsArray(root: unknown): ArrayCandidate | null {
  return detectRecordsArrays(root)[0] ?? null;
}

const ID_EXACT = /^(id|uuid|guid|_id|ref|reference|key)$/i;
const ID_SUFFIX = /(_id|id|ref|key|number|no|code|sku|uuid|guid)$/i;
const ID_EMAIL = /e-?mail/i;

/** Unique, fully filled string or number fields, best id first. */
export function idCandidates(fields: readonly FieldInfo[]): FieldInfo[] {
  return fields
    .filter((f) => f.unique && (f.type === 'string' || f.type === 'number'))
    .sort((a, b) => idRank(a.name) - idRank(b.name));
}

/** 0 for `id`-like names, 1 for `*_id`-like, 2 for an email, 3 otherwise. */
export const idRank = (name: string): number =>
  ID_EXACT.test(name) ? 0 : ID_SUFFIX.test(name) ? 1 : ID_EMAIL.test(name) ? 2 : 3;

const CHANGED = /(updated|modified|changed|edited)/i;
const CREATED = /(created|added|registered|issued|joined)/i;
const TIME_NAME = /(time|date|_at|at$|timestamp|when)/i;
// 2000-01-01 .. 2100-01-01 in epoch seconds
const EPOCH_S = [946_684_800, 4_102_444_800] as const;

function isEpoch(f: FieldInfo): boolean {
  if (f.type !== 'number' || f.numMin === undefined || f.numMax === undefined) return false;
  const [lo, hi] = EPOCH_S;
  const sec = f.numMin >= lo && f.numMax <= hi;
  const ms = f.numMin >= lo * 1000 && f.numMax <= hi * 1000;
  return sec || ms;
}

/**
 * Date, datetime and epoch-number fields, best first: changed-style names (good for incremental
 * sync), then created-style, then any other time-like name or type.
 */
export function timeCandidates(fields: readonly FieldInfo[]): FieldInfo[] {
  return fields
    .filter(
      (f) => f.type === 'date' || f.type === 'datetime' || (isEpoch(f) && timeRank(f.name) < 3),
    )
    .sort((a, b) => timeRank(a.name) - timeRank(b.name));
}

/** 0 for changed-style names, 1 for created-style, 2 for other time-like names, 3 otherwise. */
export const timeRank = (name: string): number =>
  CHANGED.test(name) ? 0 : CREATED.test(name) ? 1 : TIME_NAME.test(name) ? 2 : 3;

/** Whether an epoch-number field counts seconds or milliseconds. */
export const epochUnit = (f: FieldInfo): 'unix' | 'unix-ms' =>
  f.numMin !== undefined && f.numMin >= EPOCH_S[0] * 1000 ? 'unix-ms' : 'unix';
