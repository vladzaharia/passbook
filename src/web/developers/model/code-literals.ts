import type { Json } from './types.ts';

/**
 * Every value that reaches a code sample goes through one of these, so a value someone typed or
 * a link carried is data in the language it lands in, never code: no sample is built by pasting a
 * string between quotes. Each returns source text for one literal.
 */

/** JSON text Go and strict Python tooling accept: no lone surrogates, no byte order mark. */
const wellFormed = (text: string) =>
  text
    // An escape of a lone surrogate, not the text `\\ud800` (whose backslash is itself escaped).
    .replace(/(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/gi, '$1\\ufffd')
    .replaceAll('\uFEFF', '\\ufeff');

/** A value as JSON text for a request body (two-space indent), safe to hold in any of the languages below. */
export const jsonText = (v: Json): string => wellFormed(JSON.stringify(v, null, 2));

/** A string as a JSON literal (escapes `\`, `"`, control characters and lone surrogates). */
const jsonString = (text: string) => wellFormed(JSON.stringify(text));

/** A TypeScript string literal in single quotes, made from the JSON escaping so it cannot be left early. */
export function tsString(text: string): string {
  const inner = jsonString(text).slice(1, -1);
  // `\\.` consumes each escape pair whole, so a `\\` before a quote is never mistaken for an escape of it.
  return `'${inner.replace(/\\.|'/g, (m) => (m === "'" ? "\\'" : m === '\\"' ? '"' : m))}'`;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** An object key: bare when it is a plain identifier, quoted otherwise; `__proto__` is computed so it stays a key. */
export function tsKey(key: string): string {
  if (key === '__proto__') return `[${tsString(key)}]`;
  return IDENTIFIER.test(key) ? key : tsString(key);
}

/** A TypeScript literal for a JSON value: bare keys, single quotes. */
export function tsLiteral(v: Json, pad = ''): string {
  if (v === null || typeof v !== 'object') return typeof v === 'string' ? tsString(v) : String(v);
  const inner = `${pad}  `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + tsLiteral(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, x]) => `${inner}${tsKey(k)}: ${tsLiteral(x, inner)}`).join(',\n')},\n${pad}}`;
}

/** A Python string literal: JSON's escapes are Python's. */
export const pyString = (text: string): string => jsonString(text);

/** A Python literal for a JSON value. */
export function pyLiteral(v: Json, pad = ''): string {
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'string') return pyString(v);
  if (typeof v !== 'object') return String(v);
  const inner = `${pad}    `;
  if (Array.isArray(v)) {
    return v.length === 0
      ? '[]'
      : `[\n${v.map((x) => inner + pyLiteral(x, inner)).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) return '{}';
  const rows = entries.map(([k, x]) => `${inner}${pyString(k)}: ${pyLiteral(x, inner)}`);
  return `{\n${rows.join(',\n')},\n${pad}}`;
}

/** A Go interpreted string literal, as `strconv.Quote` writes it (JSON's escapes are Go's). */
export const goString = (text: string): string => jsonString(text);

/**
 * A Go expression for multi-line text that stays readable: a raw string, with each backtick (the
 * one character a raw string cannot hold) joined in as an interpreted literal.
 */
export function goRawString(text: string): string {
  const pieces = text.split('`').map((p) => `\`${p}\``);
  return pieces.join(' + "`" + ');
}

/** One word for a POSIX shell: single quotes, with each `'` as `'\''`. Nothing inside is expanded. */
export const shQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
