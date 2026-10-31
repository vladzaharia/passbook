import type { Condition, Expr, Json, Personalization, TemplateManifest } from '../types.ts';

/** Evaluation scope for expressions: user input plus the manifest's static lookup tables. */
export interface ExprScope {
  input: Personalization;
  lookups: NonNullable<TemplateManifest['lookups']>;
}

export const EXPR_LIMITS = {
  length: 4096,
  interpolations: 64,
  pathTokens: 8,
  output: 16384,
} as const;

export class ExprError extends Error {
  readonly expression: string;
  constructor(message: string, expression: string) {
    super(
      `${message} in "${expression.length > 80 ? `${expression.slice(0, 77)}...` : expression}"`,
    );
    this.name = 'ExprError';
    this.expression = expression;
  }
}

const FILTERS: Record<string, (value: string) => string> = {
  html: (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  url: (value) => encodeURIComponent(value),
  // Forces a string, e.g. for semantic amounts that must not be numbers.
  str: (value) => value,
};

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^[\w-]+$/;

interface Part {
  literal?: string;
  path?: string;
  filter?: string;
}

/** Splits an expression into literal and `{{path|filter}}` parts. Throws ExprError on bad syntax. */
function parse(expr: string): Part[] {
  if (expr.length > EXPR_LIMITS.length)
    throw new ExprError(`Expression is longer than ${EXPR_LIMITS.length} characters`, expr);
  const parts: Part[] = [];
  let index = 0;
  let count = 0;
  while (index < expr.length) {
    const open = expr.indexOf('{{', index);
    if (open === -1) {
      parts.push({ literal: expr.slice(index) });
      break;
    }
    if (open > index) parts.push({ literal: expr.slice(index, open) });
    const close = expr.indexOf('}}', open + 2);
    if (close === -1) throw new ExprError('Unclosed {{', expr);
    if (++count > EXPR_LIMITS.interpolations)
      throw new ExprError(`More than ${EXPR_LIMITS.interpolations} interpolations`, expr);
    const body = expr.slice(open + 2, close);
    if (body.includes('{')) throw new ExprError('Nested {{', expr);
    const [rawPath = '', rawFilter, ...extra] = body.split('|');
    const path = rawPath.trim();
    if (!path) throw new ExprError('Empty {{ }}', expr);
    if (extra.length > 0) throw new ExprError('Only one filter is allowed', expr);
    const filter = rawFilter?.trim();
    if (filter !== undefined && !FILTERS[filter])
      throw new ExprError(
        `Unknown filter "${filter}" (use ${Object.keys(FILTERS).join(', ')})`,
        expr,
      );
    tokenize(path, expr);
    parts.push(filter ? { path, filter } : { path });
    index = close + 2;
  }
  return parts;
}

function tokenize(path: string, expr: string): string[] {
  const tokens = path.match(/\[[^\]]*\]|[^.[\]]+/g) ?? [];
  if (tokens.join('').length !== path.replace(/\./g, '').length)
    throw new ExprError(`Bad path "${path}"`, expr);
  if (tokens.length > EXPR_LIMITS.pathTokens)
    throw new ExprError(`Path "${path}" is deeper than ${EXPR_LIMITS.pathTokens}`, expr);
  for (const token of tokens) {
    const inner = token.startsWith('[') ? token.slice(1, -1).trim() : token;
    if (!SEGMENT.test(inner)) throw new ExprError(`Bad path segment "${token}"`, expr);
  }
  return tokens;
}

/** Static check for manifest validation: returns the problem or null. */
export function checkExpr(expr: Expr): string | null {
  if (typeof expr !== 'string') return null;
  try {
    parse(expr);
    return null;
  } catch (error) {
    if (error instanceof ExprError) return error.message;
    throw error;
  }
}

/** Input names and lookup tables an expression reads, for manifest checks. */
export function exprReferences(expr: Expr): { inputs: string[]; lookups: string[] } {
  const inputs = new Set<string>();
  const lookups = new Set<string>();
  if (typeof expr !== 'string') return { inputs: [], lookups: [] };
  for (const part of parse(expr)) {
    if (!part.path) continue;
    const tokens = tokenize(part.path, expr);
    const first = tokens[0];
    if (first === 'lookups') {
      const table = tokens[1];
      if (table && !table.startsWith('[')) lookups.add(table);
      for (const token of tokens.slice(2))
        if (token.startsWith('[')) inputs.add(token.slice(1, -1).trim());
    } else if (first) {
      inputs.add(first);
      for (const token of tokens.slice(1))
        if (token.startsWith('[')) inputs.add(token.slice(1, -1).trim());
    }
  }
  return { inputs: [...inputs], lookups: [...lookups] };
}

function walk(root: Json | undefined, tokens: string[], scope: ExprScope): Json | undefined {
  // `a.b[c].d`: `[c]` looks the key up in the input first, then falls back to the literal.
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || typeof current !== 'object') return undefined;
    let key = token;
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1).trim();
      const fromInput = scope.input[inner];
      key =
        typeof fromInput === 'string' || typeof fromInput === 'number' ? String(fromInput) : inner;
    }
    if (BLOCKED.has(key)) return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Json | undefined;
}

export function lookupPath(path: string, scope: ExprScope): Json | undefined {
  const tokens = tokenize(path.trim(), path);
  if (tokens[0] === 'lookups')
    return walk(scope.lookups as unknown as Json, tokens.slice(1), scope);
  return walk(scope.input, tokens, scope);
}

function stringify(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Interpolation and lookups only; no loops or functions, so evaluation is bounded. */
export function evaluate(expr: Expr, scope: ExprScope): Json | undefined {
  if (typeof expr !== 'string') return expr.const;
  const parts = parse(expr);
  const first = parts[0];
  if (parts.length === 1 && first?.path && !first.filter) return lookupPath(first.path, scope);
  let out = '';
  for (const part of parts) {
    if (part.literal !== undefined) out += part.literal;
    else if (part.path) {
      const text = stringify(lookupPath(part.path, scope));
      out += part.filter ? (FILTERS[part.filter]?.(text) ?? text) : text;
    }
    if (out.length > EXPR_LIMITS.output)
      throw new ExprError(`Result is longer than ${EXPR_LIMITS.output} characters`, expr);
  }
  return out;
}

export function isEmpty(value: Json | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

const MAX_CONDITION_DEPTH = 8;

export function testCondition(condition: Condition, scope: ExprScope, depth = 0): boolean {
  if (depth > MAX_CONDITION_DEPTH) throw new ExprError('Condition is nested too deeply', '');
  if ('all' in condition) return condition.all.every((c) => testCondition(c, scope, depth + 1));
  if ('any' in condition) return condition.any.some((c) => testCondition(c, scope, depth + 1));
  if ('not' in condition) return !testCondition(condition.not, scope, depth + 1);
  const value = scope.input[condition.input];
  if (condition.eq !== undefined) return JSON.stringify(value) === JSON.stringify(condition.eq);
  if (condition.in) return condition.in.some((v) => JSON.stringify(v) === JSON.stringify(value));
  if (condition.empty !== undefined) return isEmpty(value) === condition.empty;
  return false;
}

export function conditionInputs(condition: Condition, depth = 0): string[] {
  if (depth > MAX_CONDITION_DEPTH) return [];
  if ('all' in condition) return condition.all.flatMap((c) => conditionInputs(c, depth + 1));
  if ('any' in condition) return condition.any.flatMap((c) => conditionInputs(c, depth + 1));
  if ('not' in condition) return conditionInputs(condition.not, depth + 1);
  return [condition.input];
}
