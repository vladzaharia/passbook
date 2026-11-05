/** Bindings and texts (DM 1.8, 3.1, 3.4): `{{path|filter}}`, strict missing values, plurals. Pure. */
import type { Json } from '../../types.ts';
import { applyFilter, countText, FILTERS, type FormatCtx, plain, toNumber } from './format.ts';
import type { ScanText } from './schema.ts';

export type ScanDisplayScope = Record<string, Json | undefined>;

/** A bare first segment that is one of these resolves to the root; anything else is an input. */
export const SCOPE_ROOTS = [
  'holder',
  'inputs',
  'fields',
  'pass',
  'scan',
  'history',
  'event',
  'scanner',
  'lookups',
  'now',
  'access',
  'occupancy',
] as const;
const ROOTS = new Set<string>(SCOPE_ROOTS);
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);

export interface EvalCtx extends FormatCtx {
  scope: ScanDisplayScope;
}

export interface Part {
  literal?: string;
  path?: string;
  filter?: string;
}

export const PATH_TOKENS = /[^.[\]]+|\[[^\]]*\]/g;
const SEGMENT = /^[\w-]+$/;

export function pathTokens(path: string): string[] | null {
  const tokens = path.match(PATH_TOKENS) ?? [];
  if (tokens.length === 0 || tokens.join('').length !== path.replace(/\./g, '').length) return null;
  for (const token of tokens) {
    const inner = token.startsWith('[') ? token.slice(1, -1).trim() : token;
    if (!SEGMENT.test(inner)) return null;
  }
  return tokens.length > 8 ? null : tokens;
}

export type ParseResult = { parts: Part[]; error: null } | { parts: null; error: string };
const parsed = new Map<string, ParseResult>();

/** Splits a text into literals and bindings. The error names the first problem. */
export function parseParts(source: string): ParseResult {
  const cached = parsed.get(source);
  if (cached) return cached;
  const result = parseUncached(source);
  if (parsed.size > 500) parsed.clear();
  parsed.set(source, result);
  return result;
}

function parseUncached(source: string): ParseResult {
  const parts: Part[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{{', index);
    if (open === -1) {
      parts.push({ literal: source.slice(index) });
      break;
    }
    if (open > index) parts.push({ literal: source.slice(index, open) });
    const close = source.indexOf('}}', open + 2);
    if (close === -1) return { parts: null, error: 'Unclosed {{' };
    const body = source.slice(open + 2, close);
    if (body.includes('{')) return { parts: null, error: 'Nested {{' };
    const [rawPath = '', rawFilter, ...extra] = body.split('|');
    const path = rawPath.trim();
    if (!path) return { parts: null, error: 'Empty {{ }}' };
    if (extra.length > 0) return { parts: null, error: 'Only one filter is allowed' };
    if (!pathTokens(path)) return { parts: null, error: `Bad path "${path}"` };
    const filter = rawFilter?.trim();
    if (rawFilter !== undefined && !filter) return { parts: null, error: 'Empty filter' };
    parts.push(filter ? { path, filter } : { path });
    index = close + 2;
  }
  return { parts, error: null };
}

export const interpolationCount = (source: string): number => source.split('{{').length - 1;

export const isKnownFilter = (name: string): boolean =>
  (FILTERS as readonly string[]).includes(name);

/** The root and the path under it for a binding path. */
export function splitPath(path: string): { root: string; rest: string[] } | null {
  const tokens = pathTokens(path);
  const first = tokens?.[0];
  if (!tokens || first === undefined) return null;
  return ROOTS.has(first)
    ? { root: first, rest: tokens.slice(1) }
    : { root: 'inputs', rest: tokens };
}

export function resolve(scope: ScanDisplayScope, path: string): Json | undefined {
  const split = splitPath(path);
  if (!split) return undefined;
  let current: unknown = scope[split.root];
  for (const token of split.rest) {
    if (current === null || typeof current !== 'object') return undefined;
    let key = token;
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1).trim();
      const fromInput = (scope.inputs as Record<string, Json> | undefined)?.[inner];
      key =
        typeof fromInput === 'string' || typeof fromInput === 'number' ? String(fromInput) : inner;
    }
    if (BLOCKED.has(key) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Json | undefined;
}

export function isEmptyValue(value: Json | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A lone `{{path}}` keeps its type; anything else is a string. Any empty binding gives undefined. */
export function evalExpr(source: string, ctx: EvalCtx, hash?: string): Json | undefined {
  const { parts } = parseParts(source);
  if (!parts) return undefined;
  const only = parts[0];
  if (parts.length === 1 && only?.path && !only.filter) {
    const value = resolve(ctx.scope, only.path);
    if (isEmptyValue(value) || (typeof value === 'string' && value.includes('{{')))
      return undefined;
    return value;
  }
  let out = '';
  for (const part of parts) {
    if (part.literal !== undefined) {
      out += hash === undefined ? part.literal : part.literal.replaceAll('#', hash);
      continue;
    }
    if (!part.path) continue;
    const value = resolve(ctx.scope, part.path);
    const text = part.filter ? applyFilter(part.filter, value, ctx) : plain(value);
    if (text === '') return undefined;
    out += text;
  }
  return out.includes('{{') ? undefined : out;
}

export function evalString(source: string, ctx: EvalCtx, hash?: string): string {
  const value = evalExpr(source, ctx, hash);
  return value === undefined ? '' : plain(value);
}

/** A rendered text: "" when anything it binds is empty. */
export function evalText(text: ScanText | null | undefined, ctx: EvalCtx): string {
  if (text === null || text === undefined) return '';
  if (typeof text === 'string') return evalString(text, ctx);
  const n = toNumber(evalExpr(text.count, ctx));
  if (n === null) return '';
  let form = text.other;
  if (n === 0 && text.zero !== undefined) form = text.zero;
  else if (new Intl.PluralRules(ctx.locale).select(n) === 'one') form = text.one;
  return evalString(form, ctx, countText(n, ctx.locale));
}
