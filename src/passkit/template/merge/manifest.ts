import type { Json } from '../../types.ts';
import { listOf, orderedMapOf } from './list.ts';
import { canon, isObj, leaf, mapOf, part, type Rule, spliceOrder } from './map.ts';
import { scanRule } from './scan.ts';
import { setOf } from './set.ts';
import type { Cx } from './types.ts';

type Obj = Record<string, Json>;
const bindingTarget = (b: Json) => (isObj(b) ? canon(b.to) : canon(b));
const behaviorUse = (b: Json) => (isObj(b) && typeof b.use === 'string' ? b.use : canon(b));

/** Several top-level keys share a part; their conflict paths start with the key. */
const under =
  (key: string, rule: Rule): Rule =>
  (cx, path, b, o, t) =>
    rule(cx, [...path, key], b, o, t);

const walletTarget = mapOf({ omit: setOf, images: mapOf() });

/** The §2.3 manifest rows: top-level key, its part, and its rule. */
const MANIFEST: Record<string, Rule> = {
  // manifest.meta
  description: part('manifest.meta', under('description', leaf)),
  requires: part('manifest.meta', under('requires', mapOf({ styles: setOf }))),
  messaging: part('manifest.meta', under('messaging', leaf)),
  // inputs: by name in form order; `enum` and `x-enumLabels` are one unit; `required` is a set.
  inputs: part(
    'inputs',
    mapOf({
      properties: orderedMapOf(mapOf({}, leaf, [['enum', 'x-enumLabels']])),
      required: setOf,
    }),
  ),
  sample: part('sample', mapOf()),
  lookups: part('lookups', mapOf({}, mapOf({}, mapOf()))),
  // bindings: by target and n-th with that target; order matters because later bindings win.
  bindings: part('bindings', listOf(bindingTarget, mapOf(), true)),
  display: part('display', mapOf({ search: setOf })),
  behaviors: part('behaviors', listOf(behaviorUse, mapOf({ config: mapOf() }), true)),
  previewOnlyAssets: part('previewOnlyAssets', setOf),
  scan: scanRule,
  nfc: part('nfc', mapOf()),
  // stamps: the goal and `keepReady` move together.
  stamps: part('stamps', mapOf({ art: mapOf() }, leaf, [['goal', 'keepReady']])),
  wallets: part(
    'wallets',
    mapOf({ roles: mapOf(), required: setOf, google: walletTarget, samsung: walletTarget }),
  ),
};

const other: Rule = part('manifest.meta', leaf);
const ours: Rule = (_cx, _path, _b, o) => o;

/** `name` is the fork's own. Keys outside the table merge atomically by key. */
export function mergeManifest(cx: Cx, b: unknown, o: unknown, t: unknown): Json {
  const [mb, mo, mt] = [b, o, t].map((v) => (isObj(v as Json) ? v : {})) as [Obj, Obj, Obj];
  const keys = new Set([...Object.keys(mo), ...Object.keys(mt), ...Object.keys(mb)]);
  const merged = new Map<string, Json>();
  for (const k of keys) {
    const rule = k === 'name' ? ours : (MANIFEST[k] ?? under(k, other));
    const v = rule(cx, [], mb[k], mo[k], mt[k]);
    if (v !== undefined) merged.set(k, v);
  }
  const order = spliceOrder(Object.keys(mo), Object.keys(mt), new Set(merged.keys()));
  return Object.fromEntries(order.map((k) => [k, merged.get(k) as Json]));
}
