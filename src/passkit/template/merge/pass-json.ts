import type { Json } from '../../types.ts';
import { mergeStyles, type Styles, stylesOf } from './fields.ts';
import { byIdentifier, listOf } from './list.ts';
import { container, leaf, mapOf, part, type Rule, spliceOrder, type V } from './map.ts';
import { setOf } from './set.ts';
import type { Cx } from './types.ts';

const RELEVANCE = ['locations', 'beacons', 'relevantDates', 'maxDistance', 'relevantDate'];

/** Barcodes by index, because bindings target `{barcode: n}`. */
const barcodeList: Rule = (cx, path, b, o, t) => {
  if (!(Array.isArray(o) && Array.isArray(t) && (Array.isArray(b) || cx.twoWay)))
    return leaf(cx, path, b, o, t);
  const [lb, lo, lt] = [Array.isArray(b) ? b.length : 0, o.length, t.length];
  // Indexes shift when a side adds or removes one: a count change on both sides is one conflict.
  if (cx.twoWay ? lo !== lt : lo !== lb && lt !== lb) return leaf(cx, path, b, o, t);
  const obj = (v: V) => (Array.isArray(v) ? { ...v.map((x) => x) } : undefined);
  const merged = mapOf({}, mapOf())(cx, path, obj(b), obj(o), obj(t)) as Record<string, Json>;
  return Object.keys(merged)
    .sort((x, y) => Number(x) - Number(y))
    .map((k) => merged[k] as Json);
};

interface Split {
  styles: Styles;
  meta: Record<string, Json>;
  relevance: Record<string, Json>;
  barcodes: Record<string, Json>;
  featured?: Json;
  nfc?: Json;
}

function split(pass: Json | undefined): Split | undefined {
  if (!pass || typeof pass !== 'object' || Array.isArray(pass)) return undefined;
  const styles = stylesOf(pass);
  const s: Split = { styles, meta: {}, relevance: {}, barcodes: {} };
  for (const [k, v] of Object.entries(pass)) {
    if (k in styles) continue;
    if (RELEVANCE.includes(k)) s.relevance[k] = v;
    else if (k === 'barcodes' || k === 'barcode') s.barcodes[k] = v;
    else if (k === 'featuredActions') s.featured = v;
    else if (k === 'nfc') s.nfc = v;
    else s.meta[k] = v;
  }
  return s;
}

const set = container(setOf, []);
const rules = {
  meta: part('pass.meta', container(mapOf({ semantics: container(mapOf()) }))),
  relevance: part(
    'pass.relevance',
    container(mapOf({ locations: set, beacons: set, relevantDates: set })),
  ),
  barcodes: part(
    'barcodes',
    container(mapOf({ barcodes: container(barcodeList, []), barcode: container(mapOf()) })),
  ),
  featured: part('pass.featuredActions', container(listOf(byIdentifier, mapOf()), [])),
  nfc: part('pass.nfc', leaf),
};

/** passJson is split by part, each merged by its rule, then put back in ours' key order. */
export function mergePassJson(cx: Cx, b: Json | undefined, o: Json, t: Json): Json {
  const [sb, so, st] = [split(b), split(o), split(t)];
  if (!so || !st) return leaf({ ...cx, part: 'pass.meta' }, [], b, o, t) ?? o;
  const out: Record<string, Json> = {};
  const put = (v: V, into?: Record<string, Json>) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(into ?? out, v);
  };
  put(rules.meta(cx, [], sb?.meta, so.meta, st.meta));
  put(rules.relevance(cx, [], sb?.relevance, so.relevance, st.relevance));
  put(rules.barcodes(cx, [], sb?.barcodes, so.barcodes, st.barcodes));
  const featured = rules.featured(cx, [], sb?.featured, so.featured, st.featured);
  if (featured !== undefined) out.featuredActions = featured;
  const nfc = rules.nfc(cx, [], sb?.nfc, so.nfc, st.nfc);
  if (nfc !== undefined) out.nfc = nfc;
  Object.assign(out, mergeStyles(cx, sb?.styles, so.styles, st.styles));
  const order = spliceOrder(
    Object.keys(o as object),
    Object.keys(t as object),
    new Set(Object.keys(out)),
  );
  return Object.fromEntries(order.map((k) => [k, out[k] as Json]));
}
