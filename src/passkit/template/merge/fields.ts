import type { Json } from '../../types.ts';
import { byKey, listOf } from './list.ts';
import { isObj, leaf, mapOf, part, type Rule, type V } from './map.ts';
import type { Cx } from './types.ts';

const STYLES = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'];
const GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
];

interface Style {
  key: string;
  dict: Record<string, Json>;
}

export const styleOf = (pass: Record<string, Json>): Style | undefined => {
  const key = STYLES.find((k) => isObj(pass[k]));
  return key ? { key, dict: pass[key] as Record<string, Json> } : undefined;
};

/** Every field of every group as one list; `group` becomes a property. */
const flatten = (dict: Record<string, Json> | undefined): Json[] | undefined =>
  dict &&
  GROUPS.flatMap((group) => {
    const items = dict[group];
    return Array.isArray(items) ? items.map((f) => (isObj(f) ? { ...f, group } : f)) : [];
  });

const without = (dict: Record<string, Json> | undefined) =>
  dict && Object.fromEntries(Object.entries(dict).filter(([k]) => !GROUPS.includes(k)));

function regroup(rest: Record<string, Json>, fields: Json[], seen: Set<string>) {
  const out: Record<string, Json> = { ...rest };
  for (const group of GROUPS) {
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

/** The style dict and its fields: fields merge by key across groups, the rest by key. */
export function mergeStyle(
  cx: Cx,
  b: Style | undefined,
  o: Style | undefined,
  t: Style | undefined,
) {
  const whole = (s: Style | undefined): V => s && { [s.key]: s.dict };
  if (!o || !t || o.key !== t.key) {
    const r = styleLeaf(cx, [], whole(b), whole(o), whole(t));
    return isObj(r) ? styleOf(r) : undefined;
  }
  const base = b?.key === o.key ? b : undefined;
  const seen = new Set(GROUPS.filter((g) => g in o.dict || g in t.dict));
  const rest = restRule(cx, [o.key], without(base?.dict), without(o.dict), without(t.dict));
  const fields = fieldRule(cx, [], flatten(base?.dict), flatten(o.dict), flatten(t.dict));
  return { key: o.key, dict: regroup(rest as Record<string, Json>, fields as Json[], seen) };
}
