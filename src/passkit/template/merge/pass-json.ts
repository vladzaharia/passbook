import type { Json } from '../../types.ts';
import { listOf } from './list.ts';
import { leaf, mapOf, part, type Rule, type V } from './map.ts';
import { mergeStyle, styleOf } from './fields.ts';
import { setOf } from './set.ts';
import type { Cx } from './types.ts';

const RELEVANCE = ['locations', 'beacons', 'relevantDates', 'maxDistance', 'relevantDate'];

const byIdentifier = (item: Json) =>
  typeof item === 'object' && item && !Array.isArray(item) && typeof item.identifier === 'string'
    ? item.identifier
    : JSON.stringify(item);

/** Barcodes by index, because bindings target `{barcode: n}`. */
const barcodeList: Rule = (cx, path, b, o, t) => {
  if (!(Array.isArray(o) && Array.isArray(t) && (Array.isArray(b) || cx.twoWay)))
    return leaf(cx, path, b, o, t);
  const [lb, lo, lt] = [Array.isArray(b) ? b.length : 0, o.length, t.length];
  if (lo !== lb && lt !== lb && lo !== lt) return leaf(cx, path, b, o, t);
  const obj = (v: V) => (Array.isArray(v) ? { ...v.map((x) => x) } : undefined);
  const merged = mapOf({}, mapOf())(cx, path, obj(b), obj(o), obj(t)) as Record<string, Json>;
  return Object.keys(merged)
    .sort((x, y) => Number(x) - Number(y))
    .map((k) => merged[k] as Json);
};

interface Split {
  style?: ReturnType<typeof styleOf>;
  meta: Record<string, Json>;
  relevance: Record<string, Json>;
  barcodes: Record<string, Json>;
  featured?: Json;
  nfc?: Json;
}

function split(pass: Json | undefined): Split | undefined {
  if (!pass || typeof pass !== 'object' || Array.isArray(pass)) return undefined;
  const style = styleOf(pass);
  const s: Split = { style, meta: {}, relevance: {}, barcodes: {} };
  for (const [k, v] of Object.entries(pass)) {
    if (k === style?.key) continue;
    if (RELEVANCE.includes(k)) s.relevance[k] = v;
    else if (k === 'barcodes' || k === 'barcode') s.barcodes[k] = v;
    else if (k === 'featuredActions') s.featured = v;
    else if (k === 'nfc') s.nfc = v;
    else s.meta[k] = v;
  }
  return s;
}

const rules = {
  meta: part('pass.meta', mapOf({ semantics: mapOf() })),
  relevance: part(
    'pass.relevance',
    mapOf({ locations: setOf, beacons: setOf, relevantDates: setOf }),
  ),
  barcodes: part('barcodes', mapOf({ barcodes: barcodeList, barcode: mapOf() })),
  featured: part('pass.featuredActions', listOf(byIdentifier, mapOf())),
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
  const style = mergeStyle(cx, sb?.style, so.style, st.style);
  if (style) out[style.key] = style.dict;
  const order = Object.keys(o as object);
  return Object.fromEntries(
    Object.entries(out).sort(([x], [y]) => {
      const [ix, iy] = [order.indexOf(x), order.indexOf(y)];
      return (ix < 0 ? order.length : ix) - (iy < 0 ? order.length : iy);
    }),
  );
}
