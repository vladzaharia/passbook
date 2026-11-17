// Statement fingerprints for the raw-write allowlist (tools/authority-scope.ts). A reviewed raw write is
// pinned by what it says, not by how often a table is named: comments are dropped, whitespace collapsed
// and interpolations blanked before hashing, so a reformat keeps the pin and a changed WHERE breaks it.
import { createHash } from 'node:crypto';

export interface Stripped {
  /** The source with JS comments removed. */
  text: string;
  /** Outermost string and template literals of `text`, as [start, end) offsets. */
  literals: [number, number][];
}

/**
 * Removes JS comments. String and template literals stay whole (a `//` in a URL or an SQL `--` in a string
 * is not a JS comment), `${...}` inside a template is code, and a quote left open at a line end resets.
 */
export function stripComments(source: string): Stripped {
  let text = '';
  const literals: [number, number][] = [];
  const stack: ('code' | 'template')[] = ['code'];
  const braces: number[] = [];
  let literalStart = -1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? '';
    const next = source[i + 1];
    if (stack[stack.length - 1] === 'template') {
      text += ch;
      if (ch === '\\') text += source[++i] ?? '';
      else if (ch === '`') {
        stack.pop();
        if (stack.length === 1) literals.push([literalStart, text.length]);
      } else if (ch === '$' && next === '{') {
        text += '{';
        i++;
        stack.push('code');
        braces.push(0);
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      text += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      text += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const start = text.length;
      text += ch;
      for (i++; i < source.length; i++) {
        const c = source[i] ?? '';
        if (c === '\n') {
          text += c;
          break;
        }
        text += c;
        if (c === '\\') text += source[++i] ?? '';
        else if (c === ch) break;
      }
      if (stack.length === 1) literals.push([start, text.length]);
      continue;
    }
    if (ch === '`') {
      if (stack.length === 1) literalStart = text.length;
      text += ch;
      stack.push('template');
      continue;
    }
    if (stack.length > 1) {
      if (ch === '{') braces[braces.length - 1] = (braces[braces.length - 1] ?? 0) + 1;
      else if (ch === '}') {
        if ((braces[braces.length - 1] ?? 0) === 0) {
          braces.pop();
          stack.pop();
        } else braces[braces.length - 1] = (braces[braces.length - 1] ?? 1) - 1;
      }
    }
    text += ch;
  }
  return { text, literals };
}

const MAX_INLINE_DEPTH = 4;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The index of the `}` that closes the `${` whose body starts at `from`. */
function closeBrace(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && depth-- === 0) return i;
  }
  return text.length;
}

/**
 * The text of a bare name that is a same-file `const` string or template literal declared before `at`,
 * with its own interpolations expanded; null when it is anything else (an import, a call, a variable).
 */
function constantBody(stripped: Stripped, name: string, at: number, depth: number): string | null {
  if (depth >= MAX_INLINE_DEPTH) return null;
  const decl = new RegExp(`\\bconst\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=;]+)?=\\s*`, 'g');
  let start = -1;
  for (const m of stripped.text.slice(0, at).matchAll(decl)) start = (m.index ?? 0) + m[0].length;
  const literal = stripped.literals.find(([from]) => from === start);
  if (!literal) return null;
  return expand(
    stripped,
    stripped.text.slice(literal[0] + 1, literal[1] - 1),
    literal[0],
    depth + 1,
  );
}

/** Interpolations: a same-file constant is inlined, anything else keeps its whitespace-collapsed text. */
function expand(stripped: Stripped, raw: string, at: number, depth: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      const end = closeBrace(raw, i + 2);
      const expr = raw
        .slice(i + 2, end)
        .replace(/\s+/g, ' ')
        .trim();
      const body = IDENT.test(expr) ? constantBody(stripped, expr, at, depth) : null;
      out += body === null ? `\${${expr}}` : `(${body})`;
      i = end;
    } else out += raw[i];
  }
  return out;
}

/** What follows a literal joined with `+`: further literals and expressions, as interpolations. */
function concatenatedTail(stripped: Stripped, from: number): string {
  const { text } = stripped;
  let i = from;
  let out = '';
  for (;;) {
    while (/\s/.test(text[i] ?? '')) i++;
    if (text[i] !== '+') return out;
    i++;
    while (/\s/.test(text[i] ?? '')) i++;
    const literal = stripped.literals.find(([start]) => start === i);
    if (literal) {
      out += ` ${stripped.text.slice(literal[0] + 1, literal[1] - 1)}`;
      i = literal[1];
      continue;
    }
    let depth = 0;
    const start = i;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth-- === 0) break;
      } else if (depth === 0 && (c === ',' || c === ';' || c === '+')) break;
    }
    out += ` \${${text.slice(start, i)}}`;
  }
}

/**
 * The statement that starts at `from`: to the next `;` or the end of the literal that holds it, with
 * interpolations expanded and any `+ ...` tail joined on. `holder` names the `const` (a literal or an
 * object of them) the statement is declared in, whose uses are further call sites.
 */
export function describeStatement(
  stripped: Stripped,
  from: number,
): { text: string; holder: string | null } {
  const literal = stripped.literals.find(([start, end]) => start <= from && from < end);
  const end = literal ? literal[1] - 1 : Math.min(stripped.text.length, from + 400);
  const semicolon = stripped.text.indexOf(';', from);
  const cut = semicolon !== -1 && semicolon < end;
  const raw = stripped.text.slice(from, cut ? semicolon : end);
  let text = expand(stripped, raw, from, 0);
  if (literal && !cut) text += expand(stripped, concatenatedTail(stripped, literal[1]), from, 0);
  return { text, holder: holderOf(stripped, from) };
}

/** The `const NAME = <literal | { ... } | [ ... ]>` that holds a statement, when no `;` lies between. */
function holderOf(stripped: Stripped, from: number): string | null {
  const before = stripped.text.slice(0, from);
  let found: { name: string; at: number } | null = null;
  for (const m of before.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?=['"`{[])/g))
    found = { name: m[1] ?? '', at: (m.index ?? 0) + m[0].length };
  if (!found) return null;
  // A `;` between the declaration and the statement ends the declaration (outside literals).
  const between = [...before.slice(found.at).matchAll(/;/g)].some(
    (m) =>
      !stripped.literals.some(
        ([a, b]) => a <= found.at + (m.index ?? 0) && found.at + (m.index ?? 0) < b,
      ),
  );
  return between ? null : found.name;
}

/** How many times `name` is used after its declaration: each use is a call site of its statements. */
export function usesOf(stripped: Stripped, name: string): number {
  const all = stripped.text.match(
    new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'),
  );
  return Math.max(0, (all?.length ?? 0) - 1);
}

/** Whitespace and SQL comments removed, then hashed: 12 hex characters. */
export function fingerprint(statement: string): string {
  const normalized = statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
