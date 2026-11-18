import type { Json } from '../../types.ts';
import { pathTokens, SCOPE_ROOTS } from '../scan-display/text.ts';
import { isObj } from './map.ts';
import type { RefKind } from './types.ts';

type Obj = Record<string, Json>;
/**
 * Visits a reference; a returned string replaces it in place. `unit` is the value holding it,
 * so the reference check can tell one side's copy of a site from another's.
 */
export type RefVisit = (kind: RefKind, id: string, site: string, unit?: Json) => string | undefined;
/** `visit` with every reference it sees attributed to `unit`. */
export const inUnit =
  (visit: RefVisit, unit: Json): RefVisit =>
  (kind, id, site) =>
    visit(kind, id, site, structuredClone(unit));

const ROOTS = new Set<string>(SCOPE_ROOTS);
const bracket = (t: string) => t.startsWith('[');
const join = (tokens: string[]) =>
  tokens.reduce((acc, t, i) => (i === 0 ? t : bracket(t) ? `${acc}${t}` : `${acc}.${t}`), '');

/**
 * A scan.display binding path with its references visited: `inputs.x` or a bare `x` is an input,
 * `fields.k` a field, and `[x]` an input. Returns the rewritten path, or the same one.
 */
export function scanPath(path: string, visit: RefVisit, site: string): string {
  const tokens = pathTokens(path);
  if (!tokens?.[0]) return path;
  let changed = false;
  const at = (i: number, kind: RefKind) => {
    const token = tokens[i];
    if (token === undefined || bracket(token)) return;
    const next = visit(kind, token, site);
    if (next !== undefined && next !== token) [tokens[i], changed] = [next, true];
  };
  const first = tokens[0];
  if (!ROOTS.has(first)) at(0, 'input');
  else if (first === 'inputs') at(1, 'input');
  else if (first === 'fields') at(1, 'field');
  for (const [i, t] of tokens.entries()) {
    if (!bracket(t)) continue;
    const name = t.slice(1, -1).trim();
    const next = visit('input', name, site);
    if (next !== undefined && next !== name) [tokens[i], changed] = [`[${next}]`, true];
  }
  return changed ? join(tokens) : path;
}

/** Every `{{path|filter}}` in a scan.display text, with its path visited. */
export const scanText = (text: string, visit: RefVisit, site: string): string =>
  text.replace(/\{\{([^}]*)\}\}/g, (seg, body: string) => {
    const raw = body.split('|')[0] ?? '';
    const path = raw.trim();
    const next = scanPath(path, visit, site);
    return next === path ? seg : `{{${body.replace(path, next)}}}`;
  });

function scanCond(c: Json | undefined, visit: RefVisit, site: string): void {
  if (!isObj(c)) return;
  if (typeof c.input === 'string') {
    const next = visit('input', c.input, site);
    if (next !== undefined) c.input = next;
  }
  if (typeof c.path === 'string') c.path = scanPath(c.path, visit, site);
  for (const k of ['all', 'any'])
    for (const x of Array.isArray(c[k]) ? c[k] : []) scanCond(x, visit, site);
  scanCond(c.not, visit, site);
}

const ids = (list: Json | undefined, kind: RefKind, visit: RefVisit, site: string) => {
  if (!Array.isArray(list)) return;
  for (const [i, id] of list.entries()) {
    if (typeof id !== 'string') continue;
    const next = visit(kind, id, site);
    if (next !== undefined) list[i] = next;
  }
};

/** A path of identities: an item with an id is named by it. */
const step = (v: Json, i: number) => (isObj(v) && typeof v.id === 'string' ? v.id : String(i));

/** Texts, expressions and conditions anywhere in the tree, plus the id references of rows. */
function walkTree(v: Json, at: string, visit: RefVisit): void {
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      if (typeof x === 'string') v[i] = x.includes('{{') ? scanText(x, inUnit(visit, x), at) : x;
      else walkTree(x, `${at}/${step(x, i)}`, visit);
    }
    return;
  }
  if (!isObj(v)) return;
  if (v.type === 'money') ids(v.pending, 'action', inUnit(visit, v), at);
  if (v.type === 'history' && typeof v.input === 'string')
    v.input = visit('input', v.input, at, structuredClone(v)) ?? v.input;
  if (v.type === 'image' && typeof v.source === 'string')
    v.source = visit('imageSlot', v.source, at, structuredClone(v)) ?? v.source;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'when') scanCond(x, inUnit(visit, x as Json), at);
    else if (typeof x === 'string') v[k] = x.includes('{{') ? scanText(x, inUnit(visit, x), at) : x;
    else walkTree(x, `${at}/${k}`, visit);
  }
}

/** Every reference in `scan.display`. Mutates when `visit` answers. */
export function walkScanDisplay(display: Obj, visit: RefVisit): void {
  for (const p of Array.isArray(display.panels) ? display.panels : [])
    if (isObj(p))
      ids(
        p.actions,
        'action',
        inUnit(visit, p.actions as Json),
        `scan/display/panels/${String(p.id)}/actions`,
      );
  const customer = isObj(display.customer) ? display.customer : undefined;
  if (customer) {
    if (typeof customer.panel === 'string')
      customer.panel =
        visit('panel', customer.panel, 'scan/customer/panel', customer.panel) ?? customer.panel;
    ids(customer.chips, 'chip', inUnit(visit, customer.chips as Json), 'scan/customer/chips');
  }
  walkTree(display, 'scan/display', visit);
}
