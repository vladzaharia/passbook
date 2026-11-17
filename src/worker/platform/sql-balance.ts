import { matchParens, type SqlToken, tokenizeSql } from './sql-tokens.ts';

/**
 * D1 caps expression depth at 100, and SQLite adds the height of every enclosing expression
 * while resolving a nested subquery, so cost grows quadratically with EXISTS nesting. Two
 * semantics-preserving rewrites keep statements under the cap:
 * - a long AND chain becomes a shallow tree (only parentheses are inserted);
 * - a deep subquery `WHERE w` becomes `JOIN (SELECT 1 LIMIT 1) ON (w)`. An inner-join ON
 *   filters exactly like WHERE, but FROM items are left out of the enclosing expression's
 *   height. The LIMIT stops SQLite pushing constant terms down into the one-row source, where
 *   they would be re-chained left-deep and exceed the limit again.
 * Short or unparseable statements are returned unchanged.
 */
const MIN_LENGTH = 512;
const MIN_TERMS = 4;
const DEEP_CLAUSE = 8;

type Scope = 'bare' | 'select' | 'subquery';

interface Edit {
  at: number;
  end: number;
  text: string;
  /** Applied in this order at one position: closes, then replacements, then opens. */
  rank: number;
}

interface Pass {
  tokens: SqlToken[];
  partner: number[];
  edits: Edit[];
}

// A boolean region runs from one of these to the next boundary in the same scope.
const OPENS_REGION = new Set(['WHERE', 'ON', 'HAVING']);
const ENDS_REGION = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'ON',
  'HAVING',
  'GROUP',
  'ORDER',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'RETURNING',
  'SET',
  'DO',
  'JOIN',
  'CROSS',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'NATURAL',
  'WINDOW',
  'VALUES',
  ',',
]);
// A WHERE clause can end only at these; any other boundary means we misread it.
const ENDS_WHERE = new Set(['GROUP', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW']);
const STAR_LEADS = new Set(['SELECT', 'DISTINCT', 'ALL', ',']);

const token = (pass: Pass, index: number) => pass.tokens[index] as SqlToken;

/** Merges the shallowest adjacent terms first, so a deep term stays near the root. */
function group(pass: Pass, terms: [number, number][], heights: number[]): number {
  const items = terms.map(([from, to], index) => ({
    from,
    to,
    height: heights[index] as number,
  }));
  while (items.length > 1) {
    let best = 0;
    let bestHeight = Number.POSITIVE_INFINITY;
    for (let index = 0; index < items.length - 1; index++) {
      const height = Math.max(
        (items[index] as (typeof items)[number]).height,
        (items[index + 1] as (typeof items)[number]).height,
      );
      if (height < bestHeight) {
        bestHeight = height;
        best = index;
      }
    }
    const left = items[best] as (typeof items)[number];
    const right = items[best + 1] as (typeof items)[number];
    if (items.length > 2) {
      pass.edits.push({
        at: token(pass, left.from).start,
        end: token(pass, left.from).start,
        text: '(',
        rank: 2,
      });
      pass.edits.push({
        at: token(pass, right.to).end,
        end: token(pass, right.to).end,
        text: ')',
        rank: 0,
      });
    }
    items.splice(best, 2, { from: left.from, to: right.to, height: bestHeight + 1 });
  }
  return (items[0] as (typeof items)[number]).height;
}

/** Each CASE arm is its own scope; returns the matching END and the deepest arm. */
function balanceCase(pass: Pass, start: number, last: number): { end: number; height: number } {
  let depth = 0;
  let armStart = start + 1;
  let height = 1;
  for (let at = start + 1; at <= last; at++) {
    const { word } = token(pass, at);
    if (word === '(') at = pass.partner[at] as number;
    else if (word === 'CASE') depth++;
    else if (word === 'END' && depth > 0) depth--;
    else if (depth === 0 && ['WHEN', 'THEN', 'ELSE', 'END'].includes(word)) {
      height = Math.max(height, balanceScope(pass, armStart, at - 1, 'bare'));
      armStart = at + 1;
      if (word === 'END') return { end: at, height };
    }
  }
  return { end: last, height };
}

/** A subquery in an expression is resolved on top of its parent; one in FROM or a CTE is not. */
function childScope(pass: Pass, open: number): Scope {
  const head = token(pass, open + 1).word;
  if (head !== 'SELECT' && head !== 'WITH' && head !== 'VALUES') return 'bare';
  const before = pass.tokens[open - 1]?.word ?? '';
  return ['FROM', 'JOIN', 'AS', 'MATERIALIZED'].includes(before) ? 'select' : 'subquery';
}

/** Rewrites the scope's ANDs and deep WHERE; returns its estimated expression height. */
function balanceScope(pass: Pass, first: number, last: number, kind: Scope): number {
  let inRegion = false;
  let regionStart = first;
  let ands: number[] = [];
  let heights: number[] = [];
  let term = 1;
  let between = 0;
  let isBoolean = kind === 'bare';
  let scope = 1;
  let hasFrom = false;
  let star = false;
  let inList = false;
  let clause: { at: number; height: number } | null = null;

  const flush = (end: number, extra: number) => {
    heights.push(term);
    const terms: [number, number][] = [];
    let start = regionStart;
    for (const and of ands) {
      terms.push([start, and - 1]);
      start = and + 1;
    }
    terms.push([start, end]);
    const eligible =
      (inRegion || isBoolean) &&
      terms.length >= MIN_TERMS &&
      terms.every(([from, to]) => from <= to);
    const height = eligible
      ? group(pass, terms, heights)
      : heights.reduce((depth, next) => Math.max(depth, next) + 1);
    if (clause) clause.height = Math.max(clause.height, height) + extra;
    else scope = Math.max(scope, height) + extra;
    ands = [];
    heights = [];
    term = 1;
    between = 0;
  };

  const closeClause = (end: number, safe: boolean) => {
    if (!clause) return;
    const where = token(pass, clause.at);
    if (safe && kind === 'subquery' && !star && clause.height >= DEEP_CLAUSE && end > clause.at) {
      const text = hasFrom
        ? 'JOIN (SELECT 1 LIMIT 1) ON ('
        : 'FROM (SELECT 1 LIMIT 1) JOIN (SELECT 1 LIMIT 1) ON (';
      pass.edits.push({ at: where.start, end: where.start + 5, text, rank: 1 });
      pass.edits.push({ at: token(pass, end).end, end: token(pass, end).end, text: ')', rank: 0 });
    } else scope = Math.max(scope, clause.height);
    clause = null;
  };

  for (let at = first; at <= last; at++) {
    const { word } = token(pass, at);
    if (word === '(') {
      const close = pass.partner[at] as number;
      const child = childScope(pass, at);
      const inner = balanceScope(pass, at + 1, close - 1, child);
      const height = child === 'bare' ? inner + 1 : child === 'select' ? 0 : inner * 2 + 1;
      term = Math.max(term, height);
      at = close;
    } else if (word === 'CASE') {
      const arms = balanceCase(pass, at, last);
      term = Math.max(term, arms.height + 1);
      at = arms.end;
    } else if (word === '*') {
      if (inList && STAR_LEADS.has(token(pass, at - 1).word)) star = true;
    } else if (word === 'BETWEEN') {
      between++;
    } else if (word === 'AND') {
      if (between > 0) between--;
      else {
        ands.push(at);
        heights.push(term);
        term = 1;
      }
    } else if (word === 'OR') {
      flush(at - 1, 1);
      regionStart = at + 1;
    } else if (ENDS_REGION.has(word)) {
      flush(at - 1, 0);
      closeClause(at - 1, ENDS_WHERE.has(word));
      if (word === 'SELECT') hasFrom = false;
      if (word === 'FROM') hasFrom = true;
      inList = word === 'SELECT' || (inList && word === ',');
      if (word === 'WHERE') clause = { at, height: 1 };
      inRegion = OPENS_REGION.has(word);
      isBoolean = isBoolean && word === ',';
      regionStart = at + 1;
    }
  }
  flush(last, 0);
  closeClause(last, true);
  return scope;
}

/** Returns `sql` reshaped to fit D1's expression depth, or unchanged if it cannot be parsed. */
export function balanceSqlAnd(sql: string): string {
  if (sql.length < MIN_LENGTH) return sql;
  const tokens = tokenizeSql(sql);
  const partner = tokens && matchParens(tokens);
  if (!tokens || !partner) return sql;
  const pass: Pass = { tokens, partner, edits: [] };
  balanceScope(pass, 0, tokens.length - 1, 'select');
  if (pass.edits.length === 0) return sql;
  pass.edits.sort((a, b) => a.at - b.at || a.rank - b.rank);
  let out = '';
  let cursor = 0;
  for (const edit of pass.edits) {
    out += sql.slice(cursor, edit.at) + edit.text;
    cursor = Math.max(cursor, edit.end);
    if (edit.at > cursor) cursor = edit.at;
  }
  return out + sql.slice(cursor);
}
