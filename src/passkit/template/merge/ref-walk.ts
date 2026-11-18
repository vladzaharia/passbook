import type { Json } from '../../types.ts';
import { conditionInputs } from '../expr.ts';
import { pathTokens } from '../scan-display/text.ts';
import { canon, isObj } from './map.ts';
import { type RefVisit, walkScanDisplay } from './ref-scan.ts';
import type { PackageDoc, RefKind } from './types.ts';

type Obj = Record<string, Json>;
const obj = (v: unknown): Obj | undefined => (isObj(v as Json) ? (v as Obj) : undefined);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

/** Config keys that name an input, per behavior. `venue-locations` expressions also read `venue`. */
const BEHAVIOR_INPUTS: Record<string, string[]> = {
  beacons: ['input'],
  'expiry-from-input': ['input'],
  'relevance-window': ['start', 'end'],
  'upcoming-events': ['input', 'timeZoneInput'],
  'venue-locations': ['homeInput', 'accessInput'],
};
const BEHAVIOR_EXPRS: Record<string, string[]> = {
  'venue-locations': ['key', 'value', 'label', 'url', 'linkText'],
};

const bracket = (t: string) => t.startsWith('[');
const join = (tokens: string[]) =>
  tokens.reduce((acc, t, i) => (i === 0 ? t : bracket(t) ? `${acc}${t}` : `${acc}.${t}`), '');

/**
 * Every input an expression path reads, visited: the root unless it is `lookups` or `pass`, and
 * any `[x]`. Filters and literal text are never touched. Returns the rewritten path.
 */
function exprPath(path: string, visit: (name: string) => string | undefined): string {
  const tokens = pathTokens(path);
  if (!tokens?.[0]) return path;
  let changed = false;
  for (const [i, t] of tokens.entries()) {
    const root = i === 0 && t !== 'lookups' && t !== 'pass' && !bracket(t);
    if (!root && !bracket(t)) continue;
    const name = bracket(t) ? t.slice(1, -1).trim() : t;
    const next = visit(name);
    if (next !== undefined && next !== name)
      [tokens[i], changed] = [bracket(t) ? `[${next}]` : next, true];
  }
  return changed ? join(tokens) : path;
}

/** Identities of a list, as `listOf` names them: `id#n`, the n-th item with that id. */
const nth = (items: Json[], idOf: (x: Json) => string) => {
  const seen = new Map<string, number>();
  return items.map((x) => {
    const id = idOf(x);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });
};

/**
 * Walks every cross-reference in a document: bindings, display, stamps, messaging, behaviors,
 * scan (lookup, flags, actions, access, display) and wallets. Sites are identities, not indexes.
 * Mutates when `visit` answers.
 */
export function walkRefs(doc: PackageDoc, visit: RefVisit): void {
  const man = doc.manifest as unknown as Obj;
  const set = (o: Obj | Json[] | undefined, key: string | number, kind: RefKind, site: string) => {
    const cur = (o as Obj | undefined)?.[key as string];
    if (typeof cur !== 'string') return;
    const next = visit(kind, cur, site, structuredClone(o as Json));
    if (next !== undefined) (o as Obj)[key as string] = next;
  };
  const list = (o: Obj | undefined, key: string, kind: RefKind, site: string) => {
    for (const [i] of arr(o?.[key]).entries()) set(o?.[key] as Json[], i, kind, site);
  };
  const expr = (o: Obj | undefined, key: string, site: string, skip: string[] = []) => {
    const e = o?.[key];
    if (typeof e !== 'string' || !o) return;
    const at = (name: string) => (skip.includes(name) ? undefined : visit('input', name, site, e));
    o[key] = e.replace(/\{\{([^}]*)\}\}/g, (seg, body: string) => {
      const path = (body.split('|')[0] ?? '').trim();
      const next = exprPath(path, at);
      return next === path ? seg : `{{${body.replace(path, next)}}}`;
    });
  };
  const cond = (c: unknown, site: string) => {
    const o = obj(c);
    if (!o) return;
    if (typeof o.input === 'string' && conditionInputs(o as never).length)
      set(o, 'input', 'input', site);
    for (const k of ['all', 'any']) for (const x of arr(o[k])) cond(x, site);
    cond(o.not, site);
  };
  const direct = (o: unknown, site: string) => set(obj(o), 'input', 'input', site);

  const bindings = arr(man.bindings);
  const bindingIds = nth(bindings, (b) => canon(obj(b)?.to));
  for (const [i, b] of bindings.entries()) {
    const o = obj(b);
    const to = obj(o?.to);
    if (!o) continue;
    const site = `bindings/${bindingIds[i]}`;
    if (typeof to?.field === 'string') set(to, 'field', 'field', site);
    else if (Array.isArray(to?.field)) list(to, 'field', 'field', site);
    if (typeof to?.action === 'string') set(to, 'action', 'featuredAction', site);
    if (typeof to?.barcode === 'number') visit('barcode', String(to.barcode), site, o);
    if (typeof to?.image === 'string') set(to, 'image', 'imageSlot', site);
    expr(o, 'value', site);
    cond(o.when, site);
    cond(o.remove, site);
  }

  const display = obj(man.display);
  for (const k of ['title', 'subtitle', 'status']) expr(display, k, `display/${k}`);
  const search = arr(display?.search);
  const searchIds = nth(search, String);
  for (const [i] of search.entries()) set(search, i, 'input', `display/search/${searchIds[i]}`);

  direct(man.stamps, 'stamps/input');
  for (const [id, c] of Object.entries(obj(man.counters) ?? {})) {
    direct(c, `counters/${id}/input`);
    const art = obj(obj(c)?.art);
    for (const k of Object.keys(art ?? {})) set(art, k, 'art', `counters/${id}/art/${k}`);
  }
  direct(man.messaging, 'messaging/input');
  const stampArt = obj(obj(man.stamps)?.art);
  for (const k of Object.keys(stampArt ?? {})) set(stampArt, k, 'art', `stamps/art/${k}`);

  const behaviors = arr(man.behaviors);
  const behaviorOf = (b: Json) => String(obj(b)?.use);
  const behaviorIds = nth(behaviors, behaviorOf);
  for (const [i, b] of behaviors.entries()) {
    const config = obj(obj(b)?.config);
    const site = `behaviors/${behaviorIds[i]}`;
    for (const k of BEHAVIOR_INPUTS[behaviorOf(b)] ?? []) set(config, k, 'input', site);
    for (const k of BEHAVIOR_EXPRS[behaviorOf(b)] ?? []) expr(config, k, site, ['venue']);
  }

  const scan = obj(man.scan);
  direct(scan?.lookup, 'scan/lookup');
  const flags = arr(scan?.flags);
  const flagIds = nth(flags, (f) => String(obj(f)?.input));
  for (const [i, f] of flags.entries()) direct(f, `scan/flags/${flagIds[i]}`);
  for (const a of arr(scan?.actions)) direct(a, `scan/actions/${String(obj(a)?.id)}`);
  const access = obj(scan?.access);
  const accessInput = obj(access?.input);
  for (const k of Object.keys(accessInput ?? {}))
    set(accessInput, k, 'input', `scan/access/input/${k}`);
  direct(access?.suspend, 'scan/access/suspend');
  for (const p of arr(access?.plans))
    for (const z of arr(obj(p)?.zones))
      direct(obj(z)?.zone, `scan/access/plans/${String(obj(p)?.id)}`);
  const d = obj(scan?.display);
  if (d) walkScanDisplay(d, visit);

  const wallets = obj(man.wallets);
  for (const [role, src] of Object.entries(obj(wallets?.roles) ?? {})) {
    set(obj(src), 'field', 'field', `wallets/roles/${role}`);
    expr(obj(src), 'value', `wallets/roles/${role}`);
  }
  expr(obj(wallets?.google), 'classKey', 'wallets/google/classKey');
  for (const target of ['google', 'samsung']) {
    const images = obj(obj(wallets?.[target])?.images);
    for (const slot of Object.keys(images ?? {}))
      set(images, slot, 'walletArt', `wallets/${target}/images/${slot}`);
  }
}
