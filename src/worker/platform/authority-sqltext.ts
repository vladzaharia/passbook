// Text helpers for the SQL lints: fixed text is checked with its string literals blanked, and markers
// and `?` are replaced only outside literals.
import { AuthorityError } from './authority-error.ts';

const LITERAL = /'(?:[^']|'')*'/g;

/** The SQL with every string literal emptied to `''`. An unterminated quote is refused. */
export function stripLiterals(sql: string): string {
  const out = sql.replace(LITERAL, "''");
  if (out.replace(/''/g, '').includes("'"))
    throw new AuthorityError('GRANT_SCOPE_OVERRIDE', 'Unterminated string literal in SQL.');
  return out;
}

/** Applies `fn` to the text between string literals and leaves the literals as written. */
export function mapOutsideLiterals(sql: string, fn: (text: string) => string): string {
  stripLiterals(sql);
  let out = '';
  let last = 0;
  for (const m of sql.matchAll(LITERAL)) {
    out += fn(sql.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(sql.slice(last));
}

const WRITE_WORDS =
  /\b(?:insert|update|delete|replace|attach|pragma|drop|create|alter)\b|;|--|\/\*/i;

/** Refuses write words, `;` and comments outside string literals. */
export function assertReadOnly(sql: string, what: string): void {
  if (WRITE_WORDS.test(stripLiterals(sql)))
    throw new AuthorityError('GRANT_SCOPE_OVERRIDE', `${what} is read-only SQL.`);
}

const override = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);

/**
 * Caller SQL that is spliced into a builder predicate: no quoted, bracketed or backticked identifiers
 * (D1 reads a double-quoted word as a string, so they hide text from a lint), no `;` or comments, and balanced
 * parentheses, so the text can never close the predicate it sits in. Returns the literal-stripped text.
 */
export function assertSqlText(sql: string, what: string): string {
  const text = stripLiterals(sql);
  if (/["`[]/.test(text)) throw override(`${what} cannot use quoted or bracketed identifiers.`);
  if (/;|--|\/\*/.test(text)) throw override(`${what} is one statement without comments.`);
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw override(`${what} has unbalanced parentheses.`);
  }
  if (depth !== 0) throw override(`${what} has unbalanced parentheses.`);
  return text;
}

export type WriteKind = 'insert' | 'update' | 'delete';
const WRITE_HEAD =
  /\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)(\s*\.)?/gi;

/** The tables a (literal-stripped) statement writes; a schema-qualified target is refused. */
export function writeTargetsOf(text: string): { kind: WriteKind; table: string }[] {
  const flat = text.replace(/\bDO\s+UPDATE\b/gi, 'DO CHANGE');
  return [...flat.matchAll(WRITE_HEAD)].map((m) => {
    if (m[3]) throw override('A write target cannot be schema-qualified.');
    const head = (m[1] ?? '').toLowerCase();
    const kind: WriteKind = head.startsWith('delete')
      ? 'delete'
      : head.startsWith('update')
        ? 'update'
        : 'insert';
    return { kind, table: (m[2] ?? '').toLowerCase() };
  });
}

/** Splits at commas outside parentheses. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  out.push(text.slice(from).trim());
  return out;
}
