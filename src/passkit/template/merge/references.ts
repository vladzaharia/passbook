import type { Json } from '../../types.ts';
import { conditionInputs, exprReferences } from '../expr.ts';
import { isObj } from './map.ts';
import type { PackageDoc, RenameKind } from './types.ts';

type Obj = Record<string, Json>;
const obj = (v: unknown): Obj | undefined => (isObj(v as Json) ? (v as Obj) : undefined);
const each = <T>(list: T[], fn: (item: T, i: number) => void) => {
  for (const [i, item] of list.entries()) fn(item, i);
};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

const FIELD_GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
];
const STYLES = ['generic', 'storeCard', 'coupon', 'eventTicket', 'boardingPass'];
const STAMP_ART = /^stamps\/(?!strips\/).+\.png$/;

/** An entity's value without its identity: what a rename leaves unchanged. */
export type EntityMaps = Record<RenameKind, Map<string, Json>>;

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
  };
  const pass = obj(doc.passJson);
  const style = obj(STYLES.map((k) => pass?.[k]).find((v) => obj(v)));
  for (const g of FIELD_GROUPS)
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
  for (const [name, e] of Object.entries(doc.files))
    if (STAMP_ART.test(name)) m.art.set(name, e.sha1);
  return m;
}

/** Visits a reference; a returned string replaces it in place. */
export type RefVisit = (kind: RenameKind, id: string, site: string) => string | undefined;

const nameInExpr = (expr: string, from: string, to: string) =>
  expr.replace(/\{\{[^}]*\}\}/g, (seg) =>
    seg.replace(
      new RegExp(`(?<![\\w.$])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g'),
      to,
    ),
  );

/** Walks every cross-reference in the manifest, plus art names. Mutates when `visit` answers. */
export function walkRefs(doc: PackageDoc, visit: RefVisit): void {
  const man = doc.manifest as unknown as Obj;
  const set = (o: Obj | Json[], key: string | number, kind: RenameKind, site: string) => {
    const cur = (o as Obj)[key as string];
    if (typeof cur !== 'string') return;
    const next = visit(kind, cur, site);
    if (next !== undefined) (o as Obj)[key as string] = next;
  };
  const expr = (o: Obj, key: string, site: string) => {
    const e = o[key];
    if (typeof e !== 'string') return;
    let out = e;
    for (const name of exprReferences(e).inputs) {
      const next = visit('input', name, site);
      if (next !== undefined) out = nameInExpr(out, name, next);
    }
    o[key] = out;
  };
  const cond = (c: unknown, site: string) => {
    const o = obj(c);
    if (!o) return;
    if (typeof o.input === 'string' && conditionInputs(o as never).length)
      set(o, 'input', 'input', site);
    for (const k of ['all', 'any']) each(arr(o[k]), (x) => cond(x, site));
    cond(o.not, site);
  };
  each(arr(man.bindings), (b, i) => {
    const o = obj(b);
    const to = obj(o?.to);
    if (!o) return;
    const site = `bindings/${i}`;
    if (typeof to?.field === 'string') set(to, 'field', 'field', site);
    else if (Array.isArray(to?.field))
      each(to.field, (_, n) => set(to.field as Json[], n, 'field', site));
    expr(o, 'value', site);
    cond(o.when, site);
    cond(o.remove, site);
  });
  const display = obj(man.display);
  if (display) {
    for (const k of ['title', 'subtitle', 'status']) expr(display, k, `display/${k}`);
    each(arr(display.search), (_, i) =>
      set(display.search as Json[], i, 'input', 'display/search'),
    );
  }
  const direct = (o: unknown, site: string) => obj(o) && set(obj(o) as Obj, 'input', 'input', site);
  direct(man.stamps, 'stamps');
  direct(man.messaging, 'messaging');
  const stampArt = obj(obj(man.stamps)?.art);
  for (const k of Object.keys(stampArt ?? {})) set(stampArt as Obj, k, 'art', `stamps/art/${k}`);
  const scan = obj(man.scan);
  direct(scan?.lookup, 'scan/lookup');
  each(arr(scan?.flags), (f, i) => direct(f, `scan/flags/${i}`));
  each(arr(scan?.actions), (a, i) => direct(a, `scan/actions/${i}`));
  const access = obj(scan?.access);
  const accessInput = obj(access?.input);
  for (const k of Object.keys(accessInput ?? {}))
    set(accessInput as Obj, k, 'input', `scan/access/input/${k}`);
  direct(access?.suspend, 'scan/access/suspend');
  const d = obj(scan?.display);
  for (const p of arr(d?.panels)) {
    const o = obj(p);
    each(arr(o?.actions), (_, i) =>
      set(o?.actions as Json[], i, 'action', `panel/${o?.id}/actions`),
    );
  }
  const customer = obj(d?.customer);
  if (customer) {
    set(customer, 'panel', 'panel', 'scan/customer/panel');
    each(arr(customer.chips), (_, i) =>
      set(customer.chips as Json[], i, 'chip', 'scan/customer/chips'),
    );
  }
  for (const [role, src] of Object.entries(obj(obj(man.wallets)?.roles) ?? {}))
    if (obj(src)) set(obj(src) as Obj, 'field', 'field', `wallets/roles/${role}`);
}

/** References that point at nothing in `doc`. */
export function danglingRefs(doc: PackageDoc): { kind: RenameKind; id: string; site: string }[] {
  const maps = entityMaps(doc);
  const out: { kind: RenameKind; id: string; site: string }[] = [];
  walkRefs(doc, (kind, id, site) => {
    if (!maps[kind].has(id)) out.push({ kind, id, site });
    return undefined;
  });
  return out;
}
