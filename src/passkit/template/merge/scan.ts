import type { Json } from '../../types.ts';
import { byId, listOf } from './list.ts';
import { canon, container, isObj, leaf, mapOf, part, type Rule, type V } from './map.ts';
import { setOf } from './set.ts';

const hasId = (v: Json) => isObj(v) && typeof v.id === 'string';
const isNode = (v: V) => isObj(v) && (typeof v.id === 'string' || typeof v.type === 'string');
const byInput = (f: Json) => (isObj(f) && typeof f.input === 'string' ? f.input : canon(f));

/** A header: icon, title and subtitle are atomic; chips are items with ids. */
const header: Rule = part('scan.display.header', mapOf({ chips: (...a) => tree(...a) }));
const node: Rule = mapOf({ header }, (...a) => tree(...a));
const nodes = listOf(byId, (...a) => tree(...a));

/**
 * Panels, rows, chips and variants: arrays of items with ids merge by id, objects with an id or
 * a type merge by key, anything else is atomic. A row whose `type` differs is atomic.
 */
const tree: Rule = (cx, path, b, o, t) => {
  const arrays = [b, o, t].every((v) => v === undefined || (Array.isArray(v) && v.every(hasId)));
  if (Array.isArray(o) && Array.isArray(t) && arrays && (Array.isArray(b) || cx.twoWay))
    return nodes(cx, path, b, o, t);
  if (isNode(o) && isNode(t) && (o as { type?: Json }).type === (t as { type?: Json }).type)
    return node(cx, path, b, o, t);
  return leaf(cx, path, b, o, t);
};

const c = container;
const display: Rule = part(
  'scan.display',
  c(
    mapOf({
      photo: c(mapOf()),
      notes: c(mapOf()),
      header: c(header),
      variants: part('scan.display.variants', c(tree, [])),
      panels: part('scan.display.panels', c(tree, [])),
      customer: part('scan.display.customer', c(mapOf({ chips: c(setOf, []) }))),
    }),
  ),
);

const access: Rule = part(
  'scan.access',
  c(
    mapOf({
      input: c(mapOf()),
      rules: c(mapOf()),
      plans: c(listOf(byId, mapOf({ zones: listOf(canon) })), []),
    }),
  ),
);

const scan: Rule = c(
  mapOf(
    {
      actions: part('scan.actions', c(listOf(byId, mapOf()), [])),
      window: part('scan.meta', c(mapOf())),
      flags: part('scan.meta', c(listOf(byInput, mapOf(), true), [])),
      display,
      access,
    },
    part('scan.meta', leaf),
  ),
);

export const scanRule: Rule = part('scan.meta', scan);
