import type { Condition, Expr, Json, Personalization, TemplateManifest } from '../types.ts';

/** Evaluation scope for expressions: user input plus the manifest's static lookup tables. */
export interface ExprScope {
  input: Personalization;
  lookups: NonNullable<TemplateManifest['lookups']>;
}

function walk(root: Json | undefined, path: string, scope: ExprScope): Json | undefined {
  // `a.b[c].d`: `[c]` looks the key up in the input first, then falls back to the literal.
  const tokens = path.match(/[^.[\]]+|\[[^\]]+\]/g) ?? [];
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
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Json | undefined;
}

export function lookupPath(path: string, scope: ExprScope): Json | undefined {
  const trimmed = path.trim();
  if (trimmed.startsWith('lookups.') || trimmed.startsWith('lookups[')) {
    return walk(scope.lookups as unknown as Json, trimmed.replace(/^lookups\.?/, ''), scope);
  }
  return walk(scope.input, trimmed, scope);
}

function stringify(value: Json | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Interpolation and lookups only; no loops or functions, so evaluation is bounded. */
export function evaluate(expr: Expr, scope: ExprScope): Json | undefined {
  if (typeof expr !== 'string') return expr.const;
  const whole = /^\s*\{\{([^{}]+)\}\}\s*$/.exec(expr);
  if (whole?.[1]) return lookupPath(whole[1], scope);
  return expr.replace(/\{\{([^{}]+)\}\}/g, (_, path: string) => stringify(lookupPath(path, scope)));
}

function isEmpty(value: Json | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

export function testCondition(condition: Condition, scope: ExprScope): boolean {
  if ('all' in condition) return condition.all.every((c) => testCondition(c, scope));
  if ('any' in condition) return condition.any.some((c) => testCondition(c, scope));
  if ('not' in condition) return !testCondition(condition.not, scope);
  const value = scope.input[condition.input];
  if (condition.eq !== undefined) return JSON.stringify(value) === JSON.stringify(condition.eq);
  if (condition.in) return condition.in.some((v) => JSON.stringify(v) === JSON.stringify(value));
  if (condition.empty !== undefined) return isEmpty(value) === condition.empty;
  return false;
}

export { isEmpty };
