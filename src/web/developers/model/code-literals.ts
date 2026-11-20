import type { Json } from './types.ts';

/**
 * Every value that lands in a generated snippet goes through one of these. A value is data, so it
 * is written as the language's own string literal and never spliced into code: a body or header
 * someone else supplied must not be able to close a string. Used by samples.ts and Copy as.
 */

/** A well-formed string: lone surrogates become U+FFFD (Go source must be valid UTF-8). */
const wellFormed = (s: string): string =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');

/** JavaScript and TypeScript: a JSON string is a valid string literal. */
export const tsString = (s: string): string => JSON.stringify(wellFormed(s));

/** Python: a JSON string is a valid str literal (\", \\, \n, \uXXXX). */
export const pyString = (s: string): string => JSON.stringify(wellFormed(s));

/** Go: an interpreted string; JSON's escapes are valid Go escapes. */
export const goString = (s: string): string => JSON.stringify(wellFormed(s));

/** POSIX shell: single quotes, an embedded quote closed and reopened. Nothing expands inside. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/** A body as JSON text, the one serialisation every language embeds. */
export const jsonText = (v: Json): string => JSON.stringify(v, null, 2);

const IDENT = /^[A-Za-z_$][\w$]*$/;
export const tsKey = (k: string): string => (IDENT.test(k) ? k : tsString(k));

/** A JavaScript literal for a JSON value: bare keys where legal, strings as JSON strings. */
export function tsValue(v: Json, pad = ''): string {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? tsString(v) : String(v);
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + tsValue(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}${tsKey(k)}: ${tsValue(x, inner)}`).join(',\n')},\n${pad}}`;
}

/** A Python literal for a JSON value. */
export function pyValue(v: Json, pad = ''): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return pyString(v);
  if (typeof v !== 'object') return String(v);
  const inner = `${pad}    `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + pyValue(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  const rows = entries.map(([k, x]) => `${inner}${pyString(k)}: ${pyValue(x, inner)}`);
  return `{\n${rows.join(',\n')},\n${pad}}`;
}
