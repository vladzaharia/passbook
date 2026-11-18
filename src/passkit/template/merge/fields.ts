import { type Json, PASS_STYLES } from '../../types.ts';
import { byKey, listOf } from './list.ts';
import { isObj, leaf, mapOf, part, type Rule, spliceOrder } from './map.ts';
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

/** The groups the result keeps: any with fields, and an empty one by K3 on its presence. */
function regroup(rest: Dict, fields: Json[], groups: string[], keep: (g: string) => boolean) {
  const out: Dict = { ...rest };
  for (const group of groups) {
    const items = fields.filter((f) => isObj(f) && f.group === group);
    if (items.length || keep(group))
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

const isPoster = (k: string) => k.startsWith('poster');

/** One style dict: fields merge by key across groups, the rest by key; keys keep ours' order. */
function mergeDict(cx: Cx, key: string, b: Dict | undefined, o: Dict, t: Dict): Dict {
  const groups = groupsOf(b, o, t);
  const rest = restRule(cx, [key], without(b ?? {}), without(o), without(t));
  // The main style's field ids carry no prefix, so they survive a style switch.
  const fields = fieldRule(
    cx,
    isPoster(key) ? [key] : [],
    flatten(b ?? (cx.twoWay ? undefined : {}), groups),
    flatten(o, groups),
    flatten(t, groups),
  );
  const keep = (g: string) => {
    const [inB, inO, inT] = [b !== undefined && g in b, g in o, g in t];
    if (cx.twoWay) return inO || inT;
    return inO === inT ? inO : inO !== inB ? inO : inT;
  };
  const out = regroup(rest as Dict, fields as Json[], groups, keep);
  const order = spliceOrder(Object.keys(o), Object.keys(t), new Set(Object.keys(out)));
  return Object.fromEntries(order.map((k) => [k, out[k] as Json]));
}

const mainOf = (s?: Styles) => Object.keys(s ?? {}).find((k) => !isPoster(k));
const rekey = (s: Styles | undefined, from: string | undefined, to: string | undefined) =>
  s && from && to && from !== to
    ? Object.fromEntries(Object.entries(s).map(([k, v]) => [k === from ? to : k, v]))
    : s;

/**
 * Every style dict. The main style key (`generic`, `storeCard`, …) is one `pass.style` leaf; when
 * a side switches it, the other sides' main dict moves to the new key first, so fields and the
 * rest still merge by key. A poster style merges on its own key.
 */
export function mergeStyles(cx: Cx, b: Styles | undefined, o: Styles, t: Styles): Styles {
  const [kb, ko, kt] = [mainOf(b), mainOf(o), mainOf(t)];
  let main = styleLeaf(cx, [], kb, ko, kt);
  if (typeof main !== 'string' || isPoster(main) || !PASS_STYLES.includes(main as never))
    main = ko ?? kt;
  const [sb, so, st] = [rekey(b, kb, main), rekey(o, ko, main), rekey(t, kt, main)] as [
    Styles | undefined,
    Styles,
    Styles,
  ];
  const out: Styles = {};
  const all = [...new Set([...Object.keys(so), ...Object.keys(st), ...Object.keys(sb ?? {})])];
  for (const key of all) {
    const [db, dO, dt] = [sb?.[key], so[key], st[key]];
    const r = dO && dt ? mergeDict(cx, key, db, dO, dt) : styleLeaf(cx, [key], db, dO, dt);
    if (isObj(r)) out[key] = r as Dict;
  }
  return out;
}
