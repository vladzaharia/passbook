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
  if (!expr) return rest;
  const to = prop === 'value' ? { field: key } : { field: key, prop };
  return [...rest, { to, value: expr, ...(options.optional ? { omitIfEmpty: true } : {}) }];
}

export const dropFieldBindings = (manifest: Dict, key: string): Dict[] =>
  withoutBindings(manifest, (b) => {
    const field = toOf(b).field;
    return field === key || (Array.isArray(field) && field.length === 1 && field[0] === key);
  });

export function renameFieldBindings(manifest: Dict, from: string, to: string): Dict[] {
  return bindingsOf(manifest).map((b) =>
    toOf(b).field === from ? { ...b, to: { ...toOf(b), field: to } } : b,
  );
}

export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rewrite = (text: string, from: string, to: string | null): string =>
  text.replace(
    new RegExp(`\\{\\{\\s*${escapeRe(from)}(\\s*\\|[^}]*)?\\}\\}`, 'g'),
    (_m, pipe: string) => (to === null ? '' : `{{${to}${pipe ?? ''}}}`),
  );

/** Input renamed: every expression that reads it follows. */
export function renameInputRefs(manifest: Dict, from: string, to: string): Dict {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return rewrite(v, from, to);
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
  return {
    ...manifest,
    bindings: next.bindings,
    display: {
      ...display,
      ...(Array.isArray(search) ? { search: search.map((s) => (s === from ? to : s)) } : {}),
    },
  };
}

/** Input removed: bindings that read it go, so their targets keep the static text. */
export function dropInputRefs(manifest: Dict, name: string): Dict[] {
  const reads = (v: unknown): boolean => {
    if (typeof v === 'string') return new RegExp(`\\{\\{\\s*${escapeRe(name)}\\b`).test(v);
    if (Array.isArray(v)) return v.some(reads);
    if (isRecord(v))
      return Object.entries(v).some(([k, x]) => (k === 'input' ? x === name : reads(x)));
    return false;
  };
  return withoutBindings(manifest, (b) => reads(b));
}

/** Barcode target helpers: the message and alt text bind to every barcode. */
export function barcodeSource(manifest: Dict, prop: 'message' | 'altText'): Source {
  const b = bindingsOf(manifest).find((x) => 'barcode' in toOf(x) && toOf(x).prop === prop);
  return b ? sourceOfExpr(b.value) : { kind: 'static' };
}

export function bindBarcode(manifest: Dict, prop: 'message' | 'altText', source: Source): Dict[] {
  const rest = withoutBindings(manifest, (x) => 'barcode' in toOf(x) && toOf(x).prop === prop);
  const expr = exprOf(source);
  return expr ? [...rest, { to: { barcode: '*', prop }, value: expr }] : rest;
}
