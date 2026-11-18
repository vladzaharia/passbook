import { type Json, PASS_STYLES } from '../../types.ts';
import { byKey, listOf } from './list.ts';
import { isObj, leaf, mapOf, part, type Rule, type V } from './map.ts';
import type { Cx } from './types.ts';

const KNOWN = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
const isGroup = (k: string) => k.endsWith('Fields');
const rank = (g: string) => (KNOWN.includes(g) ? KNOWN.indexOf(g) : KNOWN.length);

/** Field groups in the dicts: the known ones in card order, any others after, by name. */
const groupsOf = (...dicts: (Record<string, Json> | undefined)[]) =>
  [...new Set(dicts.flatMap((d) => Object.keys(d ?? {}).filter(isGroup)))].sort(
    (x, y) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0),
  );

type Dict = Record<string, Json>;
/** Style key to its dict. A pass can carry more than one (`posterGeneric` with a `generic` fallback). */
export type Styles = Record<string, Dict>;

export const stylesOf = (pass: Dict): Styles =>
  Object.fromEntries(PASS_STYLES.filter((k) => isObj(pass[k])).map((k) => [k, pass[k] as Dict]));

/** Every field of every group as one list; `group` becomes a property. */
const flatten = (dict: Record<string, Json> | undefined, groups: string[]): Json[] | undefined =>
  dict &&
  groups.flatMap((group) => {
    const items = dict[group];
    return Array.isArray(items) ? items.map((f) => (isObj(f) ? { ...f, group } : f)) : [];
  });

const without = (dict: Record<string, Json> | undefined) =>
  dict && Object.fromEntries(Object.entries(dict).filter(([k]) => !isGroup(k)));

function regroup(rest: Record<string, Json>, fields: Json[], groups: string[], seen: Set<string>) {
  const out: Record<string, Json> = { ...rest };
  for (const group of groups) {
    const items = fields.filter((f) => isObj(f) && f.group === group);
    if (items.length || seen.has(group))
      out[group] = items.map((f) =>
        Object.fromEntries(Object.entries(f as object).filter(([k]) => k !== 'group')),
      );
  }
  return out;
}

const fieldRule: Rule = part(
  'fields',
  listOf(byKey, mapOf(), false, (f) => (isObj(f) ? f.group : undefined)),
);
const restRule: Rule = part('pass.style', mapOf());

const styleLeaf: Rule = part('pass.style', leaf);

/** One style dict: fields merge by key across groups, the rest by key. */
function mergeDict(
  cx: Cx,
  key: string,
  path: string[],
  b: Dict | undefined,
  o: Dict,
  t: Dict,
): Dict {
  const groups = groupsOf(b, o, t);
  const seen = new Set(groups.filter((g) => g in o && g in t));
  const rest = restRule(cx, [key], without(b), without(o), without(t));
  const fields = fieldRule(
    cx,
    path.slice(0, 0),
    flatten(b, groups),
    flatten(o, groups),
    flatten(t, groups),
  );
  return regroup(rest as Dict, fields as Json[], groups, seen);
}

/**
 * Every style dict. Ours and theirs switching to different sets of styles is one `pass.style`
 * conflict; otherwise each style merges on its own, and a style only one side has is atomic.
 */
export function mergeStyles(cx: Cx, b: Styles | undefined, o: Styles, t: Styles): Styles {
  const keys = (s?: Styles) => Object.keys(s ?? {}).join('|');
  if (b && keys(o) !== keys(t) && keys(o) !== keys(b) && keys(t) !== keys(b)) {
    const r = styleLeaf(cx, [], b, o, t);
    return isObj(r) ? (r as Styles) : o;
  }
  const out: Styles = {};
  const all = [...new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b ?? {})])];
  for (const [i, key] of all.entries()) {
    const [sb, so, st] = [b?.[key], o[key], t[key]];
    const path = i === 0 ? [] : [key];
    const r = so && st ? mergeDict(cx, key, path, sb, so, st) : styleLeaf(cx, [key], sb, so, st);
    if (isObj(r)) out[key] = r as Dict;
  }
  return out;
}
