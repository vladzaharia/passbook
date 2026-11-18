import type { Json } from '../../types.ts';
import { canon, decide, eq, isObj, leaf, type Rule, spliceOrder, type V } from './map.ts';

type Entry = [id: string, value: Json];

/** Identities for an array. A repeated identity gets `#n`; `nth` numbers every item. */
function identify(items: Json[], idOf: (item: Json) => string, nth: boolean): Entry[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const id = idOf(item);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return [nth || n > 0 ? `${id}#${n}` : id, item];
  });
}

const same = (a: string[], b: string[]) => a.join('\0') === b.join('\0');

/**
 * L3: K3 per identity, plus order. Ours' order wins unless only theirs reordered the common
 * items. Both reordering differently is an `order` conflict. `entries` turns a value into
 * identified entries; `build` puts them back.
 */
function ordered(
  entries: (v: V) => Entry[] | null,
  build: (e: Entry[]) => Json,
  item: Rule,
  groupOf?: (item: Json) => Json | undefined,
): Rule {
  return (cx, path, b, o, t) => {
    const [eo, et] = [entries(o), entries(t)];
    const eb = entries(b);
    if (!(eo && et && (eb || cx.twoWay))) return leaf(cx, path, b, o, t);
    const maps = [eb ?? [], eo, et].map((e) => new Map(e));
    const [mb, mo, mt] = maps as [Map<string, Json>, Map<string, Json>, Map<string, Json>];
    const ids = new Set([...mb.keys(), ...mo.keys(), ...mt.keys()]);
    const merged = new Map<string, Json>();
    for (const id of ids) {
      const v = item(cx, [...path, id], mb.get(id), mo.get(id), mt.get(id));
      if (v !== undefined) merged.set(id, v);
    }
    const idsOf = (e: Entry[]) => e.map(([id]) => id);
    const sameGroup = (id: string) =>
      !groupOf ||
      (eq(groupOf(mb.get(id) as Json), groupOf(mo.get(id) as Json)) &&
        eq(groupOf(mo.get(id) as Json), groupOf(mt.get(id) as Json)));
    const common = (e: Entry[]) =>
      idsOf(e).filter((id) => mb.has(id) && mo.has(id) && mt.has(id) && sameGroup(id));
    const [cb, co, ct] = [common(eb ?? []), common(eo), common(et)];
    const [oMoved, tMoved] = [!same(co, cb), !same(ct, cb)];
    let primary = idsOf(eo);
    let secondary = idsOf(et);
    let moved = false;
    const orderPath = [...path, '#order'];
    if (cx.twoWay ? !same(co, ct) : oMoved && tMoved && !same(co, ct)) {
      const pick = cx.picks[`${cx.part}:${orderPath.join('/')}`];
      const v = decide(cx, orderPath, 'order', cb as Json[], co, ct);
      if (pick === 'theirs') [primary, secondary, moved] = [secondary, primary, true];
      else if (pick && typeof pick === 'object' && 'value' in pick && Array.isArray(v))
        primary = v as string[];
    } else if (!cx.twoWay && tMoved && !oMoved) {
      [primary, secondary, moved] = [secondary, primary, true];
    }
    if (moved) cx.changes.push({ part: cx.part, path, op: 'move' });
    // A field that changed group on one side takes its place from that side's order.
    const shifted = new Set(
      [...merged.keys()].filter((id) => mb.has(id) && mo.has(id) && mt.has(id) && !sameGroup(id)),
    );
    const fromTheirs = (id: string) =>
      eq(groupOf?.(mt.get(id) as Json), groupOf?.(merged.get(id) as Json)) &&
      !eq(groupOf?.(mt.get(id) as Json), groupOf?.(mo.get(id) as Json));
    const keep = new Set(merged.keys());
    let order = spliceOrder(
      primary.filter((id) => !shifted.has(id)),
      secondary.filter((id) => !shifted.has(id)),
      new Set([...keep].filter((id) => !shifted.has(id))),
    );
    for (const [ids, src] of [
      [[...shifted].filter(fromTheirs), idsOf(et)],
      [[...shifted].filter((id) => !fromTheirs(id)), idsOf(eo)],
    ] as const)
      order = spliceOrder(order, [...src], new Set([...order, ...ids]));
    return build(order.map((id) => [id, merged.get(id) as Json]));
  };
}

/** An array of identified items. `groupOf` limits order comparison to items that stay in one group. */
export function listOf(
  idOf: (item: Json) => string,
  item: Rule = leaf,
  nth = false,
  groupOf?: (item: Json) => Json | undefined,
): Rule {
  const entries = (v: V) => (Array.isArray(v) ? identify(v, idOf, nth) : null);
  return ordered(entries, (e) => e.map(([, value]) => value), item, groupOf);
}

/** An object whose key order is meaningful, merged by key. */
export function orderedMapOf(item: Rule = leaf): Rule {
  const entries = (v: V) => (isObj(v) ? Object.entries(v) : null);
  return ordered(entries, (e) => Object.fromEntries(e), item);
}

export const byId = (item: Json): string =>
  isObj(item) && typeof item.id === 'string' ? item.id : canon(item);
export const byKey = (item: Json): string =>
  isObj(item) && typeof item.key === 'string' ? item.key : canon(item);
