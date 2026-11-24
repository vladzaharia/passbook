// Statement fingerprints for the raw-write allowlist (tools/authority-scope.ts). A reviewed raw write is
// pinned by what it says, not by how often a table is named: comments are dropped, whitespace collapsed
// and interpolations blanked before hashing, so a reformat keeps the pin and a changed WHERE breaks it.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

/** Where a file sits in the tree, so `import`ed constants can be read from the files that export them. */
export interface Cx {
  rel: string;
  files: ReadonlyMap<string, string>;
  /** `file#name` pairs being inlined: a cycle stops there. */
  seen: ReadonlySet<string>;
}

export interface Stripped {
  cx?: Cx | undefined;
  /** The source with JS comments removed. */
  text: string;
  /** Outermost string and template literals of `text`, as [start, end) offsets. */
  literals: [number, number][];
}

/**
 * Removes JS comments. String and template literals stay whole (a `//` in a URL or an SQL `--` in a string
 * is not a JS comment), `${...}` inside a template is code, and a quote left open at a line end resets.
 */
export function stripComments(source: string, cx?: Cx): Stripped {
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
      const skipped = source.slice(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 1;
      text += ` ${'\n'.repeat(skipped.split('\n').length - 1)}`;
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
  return { text, literals, cx };
}

const MAX_INLINE_DEPTH = 4;
/** Wrap what `expand()` inlines (a constant, a ternary): not parentheses of the SQL, so `fingerprint` turns them back into the parentheses the pins were taken over. */
export const INLINE_OPEN = '\u0001';
export const INLINE_CLOSE = '\u0002';
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

/** A relative named import: the local name and where it comes from. */
export interface ImportedName {
  local: string;
  name: string;
  file: string;
}

/** The relative `import { a, b as c } from './x.ts'` of a file, resolved to paths in the file set. */
export function importsOf(stripped: Stripped): ImportedName[] {
  const cx = stripped.cx;
  if (!cx) return [];
  const out: ImportedName[] = [];
  for (const m of stripped.text.matchAll(
    /\bimport\s+(?!type\b)\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g,
  )) {
    const base = posix.normalize(posix.join(posix.dirname(cx.rel), m[2] ?? ''));
    const file = [base, `${base}.ts`, `${base}/index.ts`].find((f) => cx.files.has(f));
    if (!file) continue;
    for (const part of (m[1] ?? '').split(',')) {
      const [name, local] = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (name && !part.trim().startsWith('type ')) out.push({ local: local ?? name, name, file });
    }
  }
  return out;
}

const declPattern = (name: string, exported: boolean) =>
  new RegExp(
    `${exported ? '\\bexport\\s+' : ''}\\bconst\\s+${name.replace(/\$/g, '\\$')}\\s*(?::[^=;]+)?=\\s*`,
    'g',
  );

/**
 * The text of a bare name that is a `const` string or template literal, with its own interpolations
 * expanded: declared before `at` in this file, or exported by the relative file it is imported from.
 * Null when it is anything else (a call, a variable, an import from outside the tree).
 */
function constantBody(stripped: Stripped, name: string, at: number, depth: number): string | null {
  if (depth >= MAX_INLINE_DEPTH) return null;
  let start = -1;
  for (const m of stripped.text.slice(0, at).matchAll(declPattern(name, false)))
    start = (m.index ?? 0) + m[0].length;
  const literal = stripped.literals.find(([from]) => from === start);
  if (literal)
    return expand(
      stripped,
      stripped.text.slice(literal[0] + 1, literal[1] - 1),
      literal[0],
      depth + 1,
    );
  const init = start === -1 ? -1 : stripped.text.indexOf(';', start);
  const ternary = init === -1 ? null : ternaryBodies(stripped.text.slice(start, init));
  if (ternary)
    return `${expand(stripped, ternary[0], start, depth + 1)}|${expand(stripped, ternary[1], start, depth + 1)}`;
  const cx = stripped.cx;
  const imported = importsOf(stripped).find((i) => i.local === name);
  if (!cx || !imported) return null;
  const key = `${imported.file}#${imported.name}`;
  if (cx.seen.has(key)) return null;
  const other = stripComments(cx.files.get(imported.file) ?? '', {
    rel: imported.file,
    files: cx.files,
    seen: new Set([...cx.seen, key]),
  });
  let at2 = -1;
  for (const m of other.text.matchAll(declPattern(imported.name, true)))
    at2 = (m.index ?? 0) + m[0].length;
  const lit = other.literals.find(([from]) => from === at2);
  return lit ? expand(other, other.text.slice(lit[0] + 1, lit[1] - 1), lit[0], depth + 1) : null;
}

/** The body of a whole string or template literal, or null when `s` is anything else. */
function literalBody(s: string): string | null {
  const q = s[0];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (q === '`' && s[i] === '$' && s[i + 1] === '{') i = closeBrace(s, i + 2);
    else if (s[i] === q) return i === s.length - 1 ? s.slice(1, i) : null;
  }
  return null;
}

/** `cond ? 'a' : 'b'` where both branches are whole literals: their bodies. Anything else is null. */
function ternaryBodies(expr: string): [string, string] | null {
  let quote = '';
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (quote === '`' && c === '$' && expr[i + 1] === '{') i = closeBrace(expr, i + 2);
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') return null;
    else if (c === '?' && expr[i + 1] === '.') i++;
    else if (c === '?' && q === -1) q = i;
    else if (c === ':' && q !== -1) {
      const a = literalBody(expr.slice(q + 1, i).trim());
      const b = literalBody(expr.slice(i + 1).trim());
      return a !== null && b !== null ? [a, b] : null;
    }
  }
  return null;
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
      const branches = depth < MAX_INLINE_DEPTH ? ternaryBodies(expr) : null;
      const body = IDENT.test(expr)
        ? constantBody(stripped, expr, at, depth)
        : branches &&
          `${expand(stripped, branches[0], at, depth + 1)}|${expand(stripped, branches[1], at, depth + 1)}`;
      out += body === null ? `\${${expr}}` : `${INLINE_OPEN}${body}${INLINE_CLOSE}`;
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
 * The first `;` that ends the statement at `from`, or -1. In a literal it is a SQL `;`: one inside an
 * `${...}`, a quoted SQL string or a SQL comment does not end it. In code it is a `;` outside every literal.
 */
function statementEnd(stripped: Stripped, from: number, end: number, inLiteral: boolean): number {
  const { text } = stripped;
  if (!inLiteral) {
    for (let i = from; i < end; i++) {
      const lit = stripped.literals.find(([a, b]) => a <= i && i < b);
      if (lit) i = lit[1] - 1;
      else if (text[i] === ';') return i;
    }
    return -1;
  }
  for (let i = from; i < end; i++) {
    const c = text[i];
    if (c === '$' && text[i + 1] === '{') i = closeBrace(text, i + 2);
    else if (c === "'") {
      for (i++; i < end && !(text[i] === "'" && text[i + 1] !== "'"); i++) if (text[i] === "'") i++;
    } else if (c === '-' && text[i + 1] === '-') {
      while (i < end && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? end : close + 1;
    } else if (c === ';') return i;
  }
  return -1;
}

/**
 * The statement that starts at `from`: to the next `;` or the end of the literal that holds it, with
 * interpolations expanded and any `+ ...` tail joined on. `holder` names the `const` (a literal or an
 * object of them) the statement is declared in, whose uses are further call sites.
 */
export function describeStatement(
  stripped: Stripped,
  from: number,
): { text: string; holder: string | null; exported: boolean; calls: string[] } {
  const literal = stripped.literals.find(([start, end]) => start <= from && from < end);
  const end = literal ? literal[1] - 1 : Math.min(stripped.text.length, from + 400);
  const semicolon = statementEnd(stripped, from, end, literal !== undefined);
  const cut = semicolon !== -1;
  const raw = stripped.text.slice(from, cut ? semicolon : end);
  let text = expand(stripped, raw, from, 0);
  if (literal && !cut) text += expand(stripped, concatenatedTail(stripped, literal[1]), from, 0);
  return { text, calls: opaqueInterpolations(text), ...holderOf(stripped, from) };
}

/**
 * Interpolations `expand()` left as text. Their SQL is not in what is hashed, so a pin over one would
 * survive any change to it: the caller must fail instead of trusting the pin.
 */
export function opaqueInterpolations(expanded: string): string[] {
  return opaqueSpans(expanded).map((s) => s.expr);
}

/** The `${...}` interpolations of expanded statement text: whitespace-collapsed expression and the `start`..`end` of its braces. */
export function opaqueSpans(expanded: string): { expr: string; start: number; end: number }[] {
  const out: { expr: string; start: number; end: number }[] = [];
  for (let i = 0; i < expanded.length; i++)
    if (expanded[i] === '$' && expanded[i + 1] === '{') {
      const end = closeBrace(expanded, i + 2);
      out.push({
        expr: expanded
          .slice(i + 2, end)
          .replace(/\s+/g, ' ')
          .trim(),
        start: i,
        end,
      });
      i = end;
    }
  return out;
}

/** The `const NAME = <literal | { ... } | [ ... ]>` that holds a statement, when no `;` lies between. */
function holderOf(stripped: Stripped, from: number): { holder: string | null; exported: boolean } {
  const before = stripped.text.slice(0, from);
  let found: { name: string; at: number; exported: boolean } | null = null;
  for (const m of before.matchAll(
    /(\bexport\s+)?\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?=['"`{[])/g,
  ))
    found = { name: m[2] ?? '', at: (m.index ?? 0) + m[0].length, exported: m[1] !== undefined };
  if (!found) return { holder: null, exported: false };
  // A `;` between the declaration and the statement ends the declaration (outside literals).
  const between = [...before.slice(found.at).matchAll(/;/g)].some(
    (m) =>
      !stripped.literals.some(
        ([a, b]) => a <= found.at + (m.index ?? 0) && found.at + (m.index ?? 0) < b,
      ),
  );
  return between
    ? { holder: null, exported: false }
    : { holder: found.name, exported: found.exported };
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
    .replaceAll(INLINE_OPEN, '(')
    .replaceAll(INLINE_CLOSE, ')')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
