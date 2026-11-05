import { type Dict, isRecord } from './model.ts';

/** How a value is filled: typed into the template, one input, or an expression of inputs. */
export type Source =
  | { kind: 'static' }
  | { kind: 'input'; name: string }
  | { kind: 'expr'; expr: string }
  | { kind: 'scanCode' };

const ONE_INPUT = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
export const SCAN_CODE = '{{pass.scanCode}}';

export const bindingsOf = (manifest: Dict): Dict[] =>
  Array.isArray(manifest.bindings) ? manifest.bindings.filter(isRecord) : [];

export const toOf = (binding: Dict): Dict => (isRecord(binding.to) ? binding.to : {});

export function sourceOfExpr(value: unknown): Source {
  if (typeof value !== 'string') return { kind: 'static' };
  if (value.replace(/\s/g, '') === SCAN_CODE) return { kind: 'scanCode' };
  const one = ONE_INPUT.exec(value);
  return one?.[1] ? { kind: 'input', name: one[1] } : { kind: 'expr', expr: value };
}

export function exprOf(source: Source): string | null {
  if (source.kind === 'input') return `{{${source.name}}}`;
  if (source.kind === 'expr') return source.expr;
  if (source.kind === 'scanCode') return SCAN_CODE;
  return null;
}

const targetsField = (b: Dict, key: string, prop: string) => {
  const to = toOf(b);
  const fields = Array.isArray(to.field) ? to.field : [to.field];
  return fields.includes(key) && (to.prop ?? 'value') === prop;
};

/** What fills a field's `value` (or another prop). */
export function fieldSource(manifest: Dict, key: string, prop = 'value'): Source {
  const b = bindingsOf(manifest).find((x) => targetsField(x, key, prop));
  return b ? sourceOfExpr(b.value) : { kind: 'static' };
}

function withoutBindings(manifest: Dict, test: (b: Dict) => boolean): Dict[] {
  return bindingsOf(manifest).filter((b) => !test(b));
}

/** Replaces the binding of one field prop. `omitIfEmpty` keeps optional inputs from printing blanks. */
export function bindField(
  manifest: Dict,
  key: string,
  source: Source,
  options: { prop?: string; optional?: boolean } = {},
): Dict[] {
  const prop = options.prop ?? 'value';
  const rest = withoutBindings(manifest, (b) => targetsField(b, key, prop));
  const expr = exprOf(source);
  if (expr === null) return rest;
  const to = prop === 'value' ? { field: key } : { field: key, prop };
  return [...rest, { to, value: expr, ...(options.optional ? { omitIfEmpty: true } : {}) }];
}

const fieldList = (b: Dict): string[] => {
  const field = toOf(b).field;
  return (Array.isArray(field) ? field : [field]).filter((f): f is string => typeof f === 'string');
};

/** A binding aimed at several fields loses only the removed one. */
export function dropFieldBindings(manifest: Dict, key: string): Dict[] {
  return bindingsOf(manifest).flatMap((b) => {
    const fields = fieldList(b);
    if (!fields.includes(key)) return [b];
    const left = fields.filter((f) => f !== key);
    if (left.length === 0) return [];
    return [{ ...b, to: { ...toOf(b), field: left.length === 1 ? left[0] : left } }];
  });
}

export function renameFieldBindings(manifest: Dict, from: string, to: string): Dict[] {
  return bindingsOf(manifest).map((b) => {
    const field = toOf(b).field;
    if (field === from) return { ...b, to: { ...toOf(b), field: to } };
    if (Array.isArray(field) && field.includes(from))
      return { ...b, to: { ...toOf(b), field: field.map((f) => (f === from ? to : f)) } };
    return b;
  });
}

const INTERPOLATION = /\{\{([^{}]*)\}\}/g;

/**
 * Walks every `{{path|filter}}` in a string and maps the input names it reads: the first path
 * segment (`name`, `name.x`) and bracket lookups (`lookups.t[name]`). `null` removes the whole
 * interpolation. `pass` and `lookups` are not inputs.
 */
export function mapInputRefs(text: string, fn: (name: string) => string | null): string {
  return text.replace(INTERPOLATION, (_whole, body: string) => {
    const bar = body.indexOf('|');
    const path = bar < 0 ? body : body.slice(0, bar);
    const rest = bar < 0 ? '' : body.slice(bar);
    let removed = false;
    const map = (name: string) => {
      const to = fn(name);
      if (to === null) removed = true;
      return to ?? name;
    };
    const head = /^(\s*)([\w-]+)/.exec(path);
    let out = path;
    if (head && head[2] !== 'lookups' && head[2] !== 'pass')
      out = `${head[1]}${map(head[2] as string)}${path.slice(head[0].length)}`;
    out = out.replace(
      /\[(\s*)([\w-]+)(\s*)\]/g,
      (_m, a: string, n: string, c: string) => `[${a}${map(n)}${c}]`,
    );
    return removed ? '' : `{{${out}${rest}}}`;
  });
}

/** Whether a string reads the input. */
export function readsInput(text: string, name: string): boolean {
  let found = false;
  mapInputRefs(text, (n) => {
    if (n === name) found = true;
    return n;
  });
  return found;
}

/** Input renamed: every expression that reads it follows. */
export function renameInputRefs(manifest: Dict, from: string, to: string): Dict {
  const swap = (n: string) => (n === from ? to : n);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mapInputRefs(v, swap);
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) {
      const out: Dict = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = k === 'input' && x === from ? to : walk(x);
      }
      return out;
    }
    return v;
  };
  const next = walk({ bindings: manifest.bindings, display: manifest.display }) as Dict;
  const display = isRecord(next.display) ? next.display : {};
  const search = isRecord(manifest.display) ? manifest.display.search : undefined;
  const messaging = isRecord(manifest.messaging) ? manifest.messaging : undefined;
  return {
    ...manifest,
    ...(messaging?.input === from ? { messaging: { ...messaging, input: to } } : {}),
    bindings: next.bindings,
    display: {
      ...display,
      ...(Array.isArray(search) ? { search: search.map((s) => (s === from ? to : s)) } : {}),
    },
  };
}

/** What removing an input would touch, for the confirm. */
export function inputUses(manifest: Dict, name: string): { fields: number; messaging: boolean } {
  const bound = bindingsOf(manifest).filter((b) => readsAny(b, name));
  const fields = new Set(bound.flatMap(fieldList));
  const messaging = isRecord(manifest.messaging) && manifest.messaging.input === name;
  return { fields: fields.size, messaging };
}

function readsAny(v: unknown, name: string): boolean {
  if (typeof v === 'string') return readsInput(v, name);
  if (Array.isArray(v)) return v.some((x) => readsAny(x, name));
  if (isRecord(v))
    return Object.entries(v).some(([k, x]) => (k === 'input' ? x === name : readsAny(x, name)));
  return false;
}

/** Input removed: bindings that read it go, so their targets keep the static text. */
export function dropInputRefs(manifest: Dict, name: string): Dict[] {
  return withoutBindings(manifest, (b) => readsAny(b, name));
}

/** Barcode target helpers: the message and alt text bind to every barcode. */
export function barcodeSource(manifest: Dict, prop: 'message' | 'altText'): Source {
  const b = bindingsOf(manifest).find((x) => 'barcode' in toOf(x) && toOf(x).prop === prop);
  return b ? sourceOfExpr(b.value) : { kind: 'static' };
}

export function bindBarcode(manifest: Dict, prop: 'message' | 'altText', source: Source): Dict[] {
  const rest = withoutBindings(manifest, (x) => 'barcode' in toOf(x) && toOf(x).prop === prop);
  const expr = exprOf(source);
  return expr !== null ? [...rest, { to: { barcode: '*', prop }, value: expr }] : rest;
}
