import type { Json } from '../../types.ts';
import type { Conflict, ConflictKind, Cx, PartId, Resolution } from './types.ts';

/** A value on one side; `undefined` is absent. */
export type V = Json | undefined;
/** A rule merges one value from three sides and returns the result (`undefined`: absent). */
export type Rule = (cx: Cx, path: string[], b: V, o: V, t: V) => V;

export function isObj(v: V): v is { [key: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function canon(v: V): string {
  if (v === undefined) return '\0';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) {
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const eq = (a: V, b: V): boolean => a === b || canon(a) === canon(b);

export const conflictId = (part: PartId, path: string[]): string => `${part}:${path.join('/')}`;

/** Runs `rule` with `id` as the part that conflicts and changes are filed under. */
export const part =
  (id: PartId, rule: Rule): Rule =>
  (cx, path, b, o, t) => {
    const saved = cx.part;
    cx.part = id;
    try {
      return rule(cx, path, b, o, t);
    } finally {
      cx.part = saved;
    }
  };

const SCALES = new Set(['1', '2', '3']);
const IMAGE_NAME = /^((?:[\w-]+\.lproj\/)?)([A-Za-z]+)(?:@([23])x)?\.png$/;

/**
 * The value a pick stands for at `path`, or `undefined` when the pick does not fit the part: a
 * file pick only fits a file part, and an image unit takes `{scale: sha1}` or one file of the unit.
 */
function picked(cx: Cx, path: string[], pick: Resolution): { v: V } | undefined {
  if (pick === 'ours' || pick === 'theirs') return undefined;
  const files = cx.part.startsWith('files.') || cx.part === 'strings';
  const name = path.at(-1) ?? '';
  if (cx.part === 'files.image') {
    if ('value' in pick) {
      const v = pick.value;
      const ok =
        isObj(v) &&
        Object.keys(v).length > 0 &&
        Object.entries(v).every(([k, x]) => SCALES.has(k) && typeof x === 'string');
      return ok ? { v } : undefined;
    }
    const m = IMAGE_NAME.exec(pick.file.name);
    if (!m || `${m[1]}${m[2]}` !== name) return undefined;
    return { v: { [m[3] ?? '1']: pick.file.sha1 } };
  }
  if ('file' in pick) return files ? { v: { name, sha1: pick.file.sha1 } } : undefined;
  if (files && !(isObj(pick.value) && typeof pick.value.sha1 === 'string')) return undefined;
  return { v: files && isObj(pick.value) ? { name, sha1: pick.value.sha1 as string } : pick.value };
}

/** Records a conflict unless a fitting resolution was picked; returns the value to use. */
export function decide(
  cx: Cx,
  path: string[],
  kind: ConflictKind,
  b: V,
  o: V,
  t: V,
  extra?: Partial<Conflict>,
): V {
  const id = conflictId(cx.part, path);
  const pick = cx.picks[id];
  if (pick === 'ours') return o;
  if (pick === 'theirs') return t;
  const fit = pick && picked(cx, path, pick);
  if (fit) return fit.v;
  cx.conflicts.push({ id, part: cx.part, path, kind, base: b, ours: o, theirs: t, ...extra });
  return o;
}

/** K3 on an atomic value. */
export const leaf: Rule = (cx, path, b, o, t) => {
  if (eq(o, t)) return o;
  if (!cx.twoWay) {
    if (eq(b, o)) {
      const op = b === undefined ? 'add' : t === undefined ? 'remove' : 'change';
      cx.changes.push({ part: cx.part, path, op });
      return t;
    }
    if (eq(b, t)) return o;
  }
  let kind: ConflictKind = 'both-changed';
  if (!cx.twoWay) {
    if (b === undefined) kind = 'add-add';
    else if (o === undefined) kind = 'delete-modify';
    else if (t === undefined) kind = 'modify-delete';
    else if (cx.part.startsWith('files.')) kind = 'binary';
  }
  return decide(cx, path, kind, b, o, t);
};

/**
 * Ours' order, then keys only theirs has after their nearest preceding surviving neighbour, then
 * any key neither side has (a picked value) in `keep` order.
 */
export function spliceOrder(primary: string[], secondary: string[], keep: Set<string>): string[] {
  const out = primary.filter((k) => keep.has(k));
  const have = new Set(out);
  let prev: string | undefined;
  for (const k of secondary) {
    if (keep.has(k) && !have.has(k)) {
      out.splice(prev === undefined ? 0 : out.indexOf(prev) + 1, 0, k);
      have.add(k);
    }
    if (have.has(k)) prev = k;
  }
  for (const k of keep) if (!have.has(k)) out.push(k);
  return out;
}

/**
 * A container both sides added merges by key against an empty base, instead of as one value.
 * Entities (an input, a field, an action) are not containers: adding one on both sides is add-add.
 */
export const container =
  (rule: Rule, empty: Json = {}): Rule =>
  (cx, path, b, o, t) =>
    rule(
      cx,
      path,
      b === undefined && o !== undefined && t !== undefined && !cx.twoWay ? empty : b,
      o,
      t,
    );

type Obj = Record<string, Json>;

/** A group of keys that merges as one atomic unit, for example `enum` and `x-enumLabels`. */
const packKey = (keys: string[]) => keys.join('+');

function pack(v: Record<string, Json>, groups: string[][]): Record<string, Json> {
  const out: Record<string, Json> = {};
  const done = new Set<string>();
  for (const [k, val] of Object.entries(v)) {
    const group = groups.find((g) => g.includes(k));
    if (!group) {
      out[k] = val;
      continue;
    }
    if (done.has(packKey(group))) continue;
    done.add(packKey(group));
    out[packKey(group)] = Object.fromEntries(
      group.filter((g) => g in v).map((g) => [g, v[g] as Json]),
    );
  }
  return out;
}

function unpack(v: Record<string, Json>, groups: string[][]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, val] of Object.entries(v)) {
    if (groups.some((g) => packKey(g) === k) && isObj(val)) Object.assign(out, val);
    else out[k] = val;
  }
  return out;
}

/**
 * K3 per key. `rules` override `fallback` (default atomic) for named keys. Falls back to an
 * atomic merge of the whole value when a side is missing or not an object.
 */
export function mapOf(
  rules: Record<string, Rule> = {},
  fallback: Rule = leaf,
  groups: string[][] = [],
): Rule {
  return (cx, path, b, o, t) => {
    if (!(isObj(o) && isObj(t) && (isObj(b) || cx.twoWay))) return leaf(cx, path, b, o, t);
    const [pb, po, pt] = [b, o, t].map((v) => (isObj(v) ? pack(v, groups) : {})) as [Obj, Obj, Obj];
    const keys = new Set([...Object.keys(po), ...Object.keys(pt), ...Object.keys(pb)]);
    const merged: Obj = {};
    for (const k of keys) {
      const v = (rules[k] ?? fallback)(cx, [...path, k], pb[k], po[k], pt[k]);
      if (v !== undefined) merged[k] = v;
    }
    const out = unpack(merged, groups);
    const order = spliceOrder(Object.keys(o), Object.keys(t), new Set(Object.keys(out)));
    return Object.fromEntries(order.map((k) => [k, out[k] as Json]));
  };
}
