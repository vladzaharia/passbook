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

/** Refuses numbered and named parameters: `?NNN` could reach a marker's bound grant id. */
export function assertPlainParams(text: string, what: string): void {
  if (/\?\d|[:@$][a-z_]/i.test(text)) throw override(`${what} binds with plain ? only.`);
}

/** The text with the inside of every parenthesis blanked, so only depth-0 tokens remain (same length). */
function depthZero(text: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === '(') out += depth++ === 0 ? ch : ' ';
    else if (ch === ')') out += --depth === 0 ? ch : ' ';
    else out += depth > 0 ? ' ' : ch;
  }
  return out;
}

export function openOf(text: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && depth-- === 0) return i;
  }
  return -1;
}

export function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length;
}

// `x.org_id IS NULL OR x.org_id = {org}` reads platform rows or the tenant's: that OR is part of the term.
const PLATFORM_OR_OWN =
  /\b(([a-z_]\w*)\.org_id\s+IS\s+NULL\s+OR\s+)\2\.org_id\s*=\s*\{org\}|\b([a-z_]\w*)\.org_id\s*=\s*\{org\}(\s+OR\s+\3\.org_id\s+IS\s+NULL)\b/gi;
const LEAD = /(?:^|\b(?:AND|WHERE|ON|HAVING))\s*$/i;
const TRAIL =
  /^\s*(?:$|\)|AND\b|WHERE\b|GROUP\b|ORDER\b|LIMIT\b|RETURNING\b|HAVING\b|WINDOW\b|UNION\b|ON\b|LEFT\b|INNER\b|CROSS\b|JOIN\b)/i;
const CLAUSE_END =
  /\b(?:WHERE|GROUP|ORDER|LIMIT|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|RETURNING|ON|JOIN|LEFT|INNER|CROSS|FROM|SET)\b/i;

/**
 * Where a conjunct must hold: up to the top of the statement (default), up to the level whose `(` is at
 * `level` (where a read alias is defined), or (`condition`) up to the nearest subquery, accepting any term
 * inside a NOT EXISTS or NOT IN body, which only refuses more.
 */
export interface ConjunctScope {
  level?: number;
  condition?: boolean;
}

/**
 * Whether the term at [at, end) holds as a conjunct: no OR or CASE in its clause at its level or any
 * enclosing one up to `scope`, nothing but AND, WHERE or ON before it, and no NOT, function or comparison
 * around it. A group around it may be a parenthesis, `EXISTS (...)` or `x IN (...)`.
 */
export function isConjunct(
  sql: string,
  at: number,
  end: number,
  scope: ConjunctScope = {},
): boolean {
  const text = sql.replace(PLATFORM_OR_OWN, (m, a?: string, _b?: string, _c?: string, d?: string) =>
    m.replace(a ?? d ?? '', ' '.repeat((a ?? d ?? '').length)),
  );
  const isSubquery = (open: number) => /^\s*(?:SELECT|WITH)\b/i.test(text.slice(open + 1));
  if (scope.condition)
    for (let open = openOf(text, at); open >= 0; open = openOf(text, open))
      if (isSubquery(open)) {
        if (/\bNOT\s+(?:EXISTS|IN)\s*$/i.test(text.slice(0, open))) return true;
        break;
      }
  let from = at;
  let to = end;
  for (;;) {
    const open = openOf(text, from);
    const close = open < 0 ? text.length : closeOf(text, open);
    const level = depthZero(text.slice(open + 1, close));
    // The OR / CASE scan covers the term's own clause (WHERE, ON, HAVING), not a select list or SET.
    let start = 0;
    for (const c of level.slice(0, from - open - 1).matchAll(/\b(?:WHERE|ON|HAVING)\b/gi))
      start = (c.index ?? 0) + c[0].length;
    const tail = level.slice(to - open - 1);
    const stop = to - open - 1 + (CLAUSE_END.exec(tail)?.index ?? tail.length);
    if (/\b(?:OR|CASE)\b/i.test(level.slice(start, stop))) return false;
    let before = level.slice(0, from - open - 1);
    if (from !== at) before = before.replace(/(?:\bEXISTS|[\w.{}]+\s+IN)\s*$/i, '');
    if (!LEAD.test(before) || !TRAIL.test(level.slice(to - open - 1))) return false;
    if (open < 0 || open === scope.level || (scope.condition && isSubquery(open))) return true;
    from = open;
    to = close + 1;
  }
}

/** True when some match of `re` (global) inside the scope's level holds as a conjunct there. */
export function hasConjunct(text: string, re: RegExp, scope: ConjunctScope = {}): boolean {
  const level = scope.level ?? -1;
  const end = level < 0 ? text.length : closeOf(text, level);
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > level && at < end && isConjunct(text, at, at + m[0].length, scope)) return true;
  }
  return false;
}

/** Every `x.org_id = {org}` and `x.mode = {mode}` in a condition holds as a conjunct (scoped). */
export function assertTenantConjuncts(text: string, what: string): void {
  const re = /\b\w+\.(org_id|mode)\s*=\s*\{(org|mode)\}|\{(org|mode)\}\s*=\s*\w+\.(org_id|mode)\b/g;
  for (const m of text.matchAll(re))
    if (!isConjunct(text, m.index ?? 0, (m.index ?? 0) + m[0].length, { condition: true }))
      throw override(`${what} keeps its tenant term a conjunct: no OR, CASE or NOT around it.`);
}

/** A FROM list joined with a comma: its later tables escape the per-alias tenant terms. */
export function hasCommaJoin(text: string): boolean {
  for (const m of text.matchAll(/(?<!\bDISTINCT\s+)\bFROM\b/gi)) {
    const at = m.index ?? 0;
    const open = openOf(text, at);
    const close = open < 0 ? text.length : closeOf(text, open);
    const rest = depthZero(text.slice(open + 1, close)).slice(at - open - 1 + m[0].length);
    const end =
      /\b(?:WHERE|GROUP|ORDER|LIMIT|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|RETURNING)\b|\bON\s+CONFLICT\b/i.exec(
        rest,
      )?.index ?? rest.length;
    if (rest.slice(0, end).includes(',')) return true;
  }
  return false;
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
