// A caller-built fragment in a pinned statement can only be trusted to narrow the WHERE when it is
// ANDed in as `AND (${fragment})`: its own parentheses keep an OR inside it from widening the WHERE, and
// the conjunction keeps it from being OR-joined. The statement text is `expand()`'s output, where
// INLINE_OPEN/INLINE_CLOSE wrap what it inlined (a constant, a ternary branch pair `a|b`): not SQL structure.
import { isBindMarker } from './authority-scope-opaque.ts';
import { INLINE_CLOSE, INLINE_OPEN, opaqueSpans } from './authority-scope-statements.ts';

const TRAILING = new RegExp(`[\\s${INLINE_OPEN}]+$`);
const LEADING = new RegExp(`^[\\s${INLINE_CLOSE}]+`);
const SUBQUERY = new RegExp(`^[\\s${INLINE_OPEN}]*(?:SELECT|WITH)\\b`, 'i');
const TERM_ENDS = new Set([
  'AND',
  'ORDER',
  'GROUP',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'RETURNING',
  'ON',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'WINDOW',
  'THEN',
  'ELSE',
  'END',
]);
const sentinel = (c: string | undefined) => c === INLINE_OPEN || c === INLINE_CLOSE;

/** Spaces for SQL comments and single-quoted strings (and every `${...}` body), keeping offsets. */
function blank(statement: string): string {
  const spans = opaqueSpans(statement);
  const out = [...statement];
  const fill = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n' && !sentinel(out[i])) out[i] = ' ';
  };
  for (const { start, end } of spans) for (let i = start + 2; i < end; i++) out[i] = '_';
  const at = (i: number) => spans.find((s) => s.start <= i && i <= s.end);
  for (let i = 0; i < out.length; i++) {
    const span = at(i);
    if (span) {
      i = span.end;
      continue;
    }
    if (out[i] === '-' && out[i + 1] === '-') {
      let j = i;
      while (j < out.length && out[j] !== '\n') j++;
      fill(i, j);
      i = j;
    } else if (out[i] === '/' && out[i + 1] === '*') {
      const close = statement.indexOf('*/', i + 2);
      const j = close === -1 ? out.length : close + 2;
      fill(i, j);
      i = j - 1;
    } else if (out[i] === "'") {
      let j = i + 1;
      while (j < out.length && !(out[j] === "'" && out[j + 1] !== "'")) j += out[j] === "'" ? 2 : 1;
      fill(i + 1, j);
      i = j;
    }
  }
  return out.join('');
}

interface Frame {
  open: number;
  close: number;
}

/** Findings for the opaque fragments of one expanded statement; `[]` when each is parenthesized and ANDed. */
export function fragmentPlacement(statement: string): string[] {
  const spans = opaqueSpans(statement).filter((s) => !isBindMarker(s.expr));
  if (spans.length === 0) return [];
  const masked = blank(statement);
  const real: Frame[] = [];
  const inline: Frame[] = [];
  const depth: number[] = [];
  const stack: { open: number; sql: boolean }[] = [];
  let sqlDepth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    depth[i] = sqlDepth;
    if (c === '(' || c === INLINE_OPEN) {
      stack.push({ open: i, sql: c === '(' });
      if (c === '(') sqlDepth++;
    } else if ((c === ')' || c === INLINE_CLOSE) && stack.length > 0) {
      const f = stack.pop() as { open: number; sql: boolean };
      (f.sql ? real : inline).push({ open: f.open, close: i });
      if (f.sql) sqlDepth--;
      depth[i] = sqlDepth;
    }
  }
  const innermost = (frames: Frame[], at: number) =>
    frames.filter((f) => f.open < at && f.close > at).sort((a, b) => b.open - a.open)[0];

  /** The connective before the group that opens at `at`: walks over inlined branches, NOT, EXISTS and `x IN`. */
  const connective = (at: number): 'and' | 'where' | 'or' | 'start' | 'other' => {
    let prior = masked.slice(0, at);
    for (;;) {
      prior = prior.trimEnd();
      const last = prior[prior.length - 1];
      if (last === INLINE_OPEN) prior = prior.slice(0, -1);
      else if (last === '|' && prior[prior.length - 2] !== '|') {
        const f = innermost(inline, prior.length - 1);
        prior = f ? prior.slice(0, f.open) : prior.slice(0, -1);
      } else if (/(?<![\w$])(?:NOT|EXISTS)$/i.test(prior)) prior = prior.replace(/\w+$/, '');
      else if (/(?<![\w$])IN$/i.test(prior))
        prior = prior
          .replace(/\w+$/, '')
          .trimEnd()
          .replace(/(?<![\w$])NOT$/i, '')
          .trimEnd()
          .replace(/[\w$.?]+$/, '');
      else if (/(?:<>|!=|<=|>=|=|<|>)$/.test(prior))
        prior = prior
          .replace(/(?:<>|!=|<=|>=|=|<|>)$/, '')
          .trimEnd()
          .replace(/[\w$.?]+$/, '');
      else break;
    }
    if (prior.endsWith('(')) return 'start';
    const word = /(?<![\w$])(AND|OR|WHERE)$/i.exec(prior)?.[1]?.toUpperCase();
    // `x BETWEEN a AND (${f})`: that AND is part of the comparison, not a connective.
    if (word === 'AND') {
      const head = prior.slice(0, -3);
      const last = [...head.matchAll(/(?<![\w$])(?:AND|OR|WHERE)(?![\w$])/gi)].pop();
      if (/(?<![\w$])BETWEEN(?![\w$])/i.test(head.slice(last ? last.index + last[0].length : 0)))
        return 'other';
    }
    return word === 'AND' ? 'and' : word === 'OR' ? 'or' : word === 'WHERE' ? 'where' : 'other';
  };
  /**
   * Does the text from `from` end a term: AND, `)`, the end or a clause keyword next, never OR. A ternary
   * there is `a|b`: every branch must end it, and an empty branch goes on after the ternary.
   */
  const endsTerm = (from: number): boolean => {
    let i = from;
    for (;;) {
      while (/\s/.test(masked[i] ?? '') || masked[i] === INLINE_CLOSE) i++;
      if (masked[i] === '|' && masked[i + 1] !== '|') {
        const f = innermost(inline, i);
        if (!f) return false;
        i = f.close + 1;
      } else if (masked[i] === INLINE_OPEN) {
        const frame = inline.find((f) => f.open === i);
        if (!frame) return false;
        const cuts = [frame.open];
        for (let j = frame.open + 1; j < frame.close; j++)
          if (
            masked[j] === '|' &&
            masked[j + 1] !== '|' &&
            masked[j - 1] !== '|' &&
            innermost(inline, j) === frame
          )
            cuts.push(j);
        cuts.push(frame.close);
        return cuts.slice(0, -1).every((cut, n) => {
          const branch = masked.slice(cut + 1, cuts[n + 1]);
          return branch.trim() === '' ? endsTerm(frame.close + 1) : endsTerm(cut + 1);
        });
      } else break;
    }
    if (i >= masked.length || masked[i] === ')') return true;
    const word = /^[A-Za-z]+/.exec(masked.slice(i))?.[0]?.toUpperCase() ?? '';
    return TERM_ENDS.has(word);
  };
  /** Is `at` inside a WHERE condition: a WHERE earlier on its level or an outer one, not past a subquery's select list. */
  const inWhere = (at: number) => {
    for (let pos = at; ; ) {
      const group = innermost(real, pos);
      const level = group ? (depth[group.open] ?? 0) + 1 : 0;
      for (const m of masked.slice(0, pos).matchAll(/(?<![\w$])WHERE(?![\w$])/gi))
        if (m.index > (group?.open ?? -1) && depth[m.index] === level) return true;
      if (!group || SUBQUERY.test(masked.slice(group.open + 1))) return false;
      pos = group.open;
    }
  };

  const out: string[] = [];
  for (const { expr, start, end } of spans) {
    const before = masked.slice(0, start).replace(TRAILING, '');
    const after = masked.slice(end + 1).replace(LEADING, '');
    if (!before.endsWith('(') || !after.startsWith(')')) {
      out.push(`\${${expr}} is not parenthesized: interpolate it as AND (\${${expr}})`);
      continue;
    }
    // Only a WHERE condition can be widened; a SET or CASE value, or a select list, cannot.
    let at = before.length - 1;
    if (!inWhere(at)) continue;
    let close = masked.indexOf(')', end + 1);
    for (;;) {
      const how = connective(at);
      if (how === 'or' || how === 'other' || !endsTerm(close + 1)) {
        out.push(
          `\${${expr}} is not ANDed into the WHERE (OR-joined before or after, or bare, here or in a group around it): write AND (\${${expr}})`,
        );
        break;
      }
      const group = innermost(real, at);
      if (!group) break;
      at = group.open;
      close = group.close;
      if (!inWhere(at)) break;
    }
  }
  return out;
}
