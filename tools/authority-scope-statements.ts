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

/** The statement that starts at `from`: to the next `;` or the end of the literal that holds it. */
export function statementAt(stripped: Stripped, from: number): string {
  const literal = stripped.literals.find(([start, end]) => start <= from && from < end);
  const end = literal ? literal[1] - 1 : Math.min(stripped.text.length, from + 400);
  const semicolon = stripped.text.indexOf(';', from);
  return stripped.text.slice(from, semicolon !== -1 && semicolon < end ? semicolon : end);
}

/** Whitespace, SQL comments and interpolation bodies removed, then hashed: 12 hex characters. */
export function fingerprint(statement: string): string {
  const normalized = statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$\{[^}]*\}/g, '$[]')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
