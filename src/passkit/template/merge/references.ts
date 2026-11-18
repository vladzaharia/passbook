import { type Json, PASS_STYLES } from '../../types.ts';
import { isObj } from './map.ts';
import { walkRefs } from './ref-walk.ts';
import type { PackageDoc, RefKind } from './types.ts';

type Obj = Record<string, Json>;
const obj = (v: unknown): Obj | undefined => (isObj(v as Json) ? (v as Obj) : undefined);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

const STAMP_ART = /^stamps\/(?!strips\/).+\.png$/;
const IMAGE_SLOT = /^(?:[\w-]+\.lproj\/)?([A-Za-z]+)(?:@[23]x)?\.png$/;

/** Every reference target by identity; for a renameable one, its value without its identity. */
export type EntityMaps = Record<RefKind, Map<string, Json>>;

const rest = (o: Obj, drop: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== drop));

/** Every renameable entity in a document, by identity. */
export function entityMaps(doc: PackageDoc): EntityMaps {
  const m: EntityMaps = {
    field: new Map(),
    input: new Map(),
    action: new Map(),
    plan: new Map(),
    panel: new Map(),
    row: new Map(),
    chip: new Map(),
    art: new Map(),
    featuredAction: new Map(),
    barcode: new Map(),
    imageSlot: new Map(),
    walletArt: new Map(),
  };
  const pass = obj(doc.passJson);
  for (const style of PASS_STYLES.map((k) => obj(pass?.[k])))
    for (const g of Object.keys(style ?? {}).filter((k) => k.endsWith('Fields')))
      for (const f of arr(style?.[g])) {
        const o = obj(f);
        if (o && typeof o.key === 'string') m.field.set(o.key, { ...rest(o, 'key'), group: g });
      }
  const man = doc.manifest as unknown as Obj;
  for (const [k, v] of Object.entries(obj(obj(man.inputs)?.properties) ?? {})) m.input.set(k, v);
  const scan = obj(man.scan);
  const ids = (into: Map<string, Json>, list: unknown) => {
    for (const item of arr(list)) {
      const o = obj(item);
      if (o && typeof o.id === 'string') into.set(o.id, rest(o, 'id'));
    }
  };
  ids(m.action, scan?.actions);
  ids(m.plan, obj(scan?.access)?.plans);
  const display = obj(scan?.display);
  ids(m.chip, obj(display?.header)?.chips);
  for (const v of arr(display?.variants)) ids(m.chip, obj(obj(v)?.header)?.chips);
  ids(m.panel, display?.panels);
  for (const p of arr(display?.panels))
    for (const r of arr(obj(p)?.rows)) {
      ids(m.row, [r]);
      ids(m.chip, obj(r)?.type === 'chips' ? obj(r)?.items : []);
    }
  for (const a of arr(pass?.featuredActions)) {
    const o = obj(a);
    if (o && typeof o.identifier === 'string')
      m.featuredAction.set(o.identifier, rest(o, 'identifier'));
  }
  for (const [i, b] of arr(pass?.barcodes).entries()) m.barcode.set(String(i), b);
  for (const [name, e] of Object.entries(doc.files)) {
    if (STAMP_ART.test(name)) m.art.set(name, e.sha1);
    if (name.startsWith('wallets/')) m.walletArt.set(name, e.sha1);
    const slot = IMAGE_SLOT.exec(name)?.[1];
    if (slot) m.imageSlot.set(slot, true);
  }
  return m;
}

export interface Ref {
  kind: RefKind;
  id: string;
  site: string;
}

/** Every reference in `doc`, and whether its target is there. */
export function refsOf(doc: PackageDoc): (Ref & { dangling: boolean })[] {
  const maps = entityMaps(doc);
  const out: (Ref & { dangling: boolean })[] = [];
  walkRefs(structuredClone(doc), (kind, id, site) => {
    out.push({ kind, id, site, dangling: !maps[kind].has(id) });
    return undefined;
  });
  return out;
}

const keyOf = (r: Ref) => `${r.kind}\0${r.id}\0${r.site}`;
const barcodeCount = (d: PackageDoc) => arr(obj(d.passJson)?.barcodes).length;

/**
 * References the merge broke. A dangling reference in `merged` counts unless some side has the
 * same reference dangling too (that side made it so). A barcode index also breaks when a side
 * changed the barcode count and does not have that binding itself: its index now means another
 * barcode.
 */
export function brokenRefs(
  merged: PackageDoc,
  base: PackageDoc | null,
  ours: PackageDoc,
  theirs: PackageDoc[],
): Ref[] {
  const sides = [ours, ...theirs].map(refsOf);
  const owned = new Set(sides.flatMap((refs) => refs.filter((r) => r.dangling).map(keyOf)));
  const out = new Map<string, Ref>();
  const refs = refsOf(merged);
  for (const r of refs)
    if (r.dangling && !owned.has(keyOf(r)))
      out.set(keyOf(r), { kind: r.kind, id: r.id, site: r.site });
  const [lo, lt] = [ours, theirs[0] as PackageDoc].map(barcodeCount) as [number, number];
  const lb = base ? barcodeCount(base) : undefined;
  const moved = [
    { refs: sides[0], changed: lb === undefined ? lo !== lt : lo !== lb },
    { refs: sides.slice(1).flat(), changed: lb === undefined ? lo !== lt : lt !== lb },
  ];
  for (const r of refs) {
    if (r.kind !== 'barcode') continue;
    for (const side of moved)
      if (side.changed && !side.refs?.some((x) => x.kind === 'barcode' && x.site === r.site))
        out.set(keyOf(r), { kind: r.kind, id: r.id, site: r.site });
  }
  return [...out.values()];
}
