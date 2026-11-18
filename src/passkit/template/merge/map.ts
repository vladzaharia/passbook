import type { Json } from '../../types.ts';
import type { Conflict, ConflictKind, Cx, PartId } from './types.ts';

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

/** Records a conflict unless a resolution was picked; returns the value to use. */
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
  if (pick) return 'value' in pick ? pick.value : (pick.file as unknown as Json);
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

/** Ours' order, then keys only theirs has after their nearest preceding surviving neighbour. */
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
  return out;
}

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
    const [pb, po, pt] = [b, o, t].map((v) => (isObj(v) ? pack(v, groups) : {}));
    const keys = new Set([...Object.keys(po as object), ...Object.keys(pt as object)]);
    const out: Record<string, Json> = {};
    for (const k of Object.keys(pb as object)) keys.add(k);
    const merged = new Map<string, Json>();
    for (const k of keys) {
      const rule = rules[k] ?? fallback;
      const v = rule(
        cx,
        [...path, k],
        (pb as Record<string, Json>)[k],
        (po as Record<string, Json>)[k],
        (pt as Record<string, Json>)[k],
      );
      if (v !== undefined) merged.set(k, v);
    }
    const order = spliceOrder(
      Object.keys(po as object),
      Object.keys(pt as object),
      new Set(merged.keys()),
    );
    for (const k of order) out[k] = merged.get(k) as Json;
    return unpack(out, groups);
  };
}
