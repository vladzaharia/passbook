// Interpolations the raw-write fingerprint cannot see into (tools/authority-scope-statements.ts leaves
// them as text). A pinned statement with one would survive any change to the SQL behind it, so each one
// is a finding unless it is a bind-marker list or reviewed here: its exact text, plus a hash of the
// normalized source of the file and the files whose SQL it builds, so editing any of them needs a review.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { opaqueSpans, stripComments } from './authority-scope-statements.ts';

export interface OpaqueEntry {
  reason: string;
  /** Exact whitespace-collapsed texts of the reviewed interpolations. */
  exprs: string[];
  /** Files that build a caller-supplied fragment without being imported here; the imports are read from the source. */
  via?: string[];
  /** `opaqueHash` of the file, the files it imports, and `via`. */
  hash: string;
}

/** Bind-marker lists carry no terms: `placeholders(n)`, `ids.map(() => '?')`, `IN_IDS(cls)`, `IN_ROWS(t)`. */
const BIND_MARKERS = [
  /^placeholders\([^)]*\)$/,
  /^[\w$.]+\.map\(\(\) => '\?'\)\.join\([^)]*\)$/,
  /^IN_(?:IDS|ROWS)\([^)]*\)$/,
];

export const isBindMarker = (expr: string): boolean => BIND_MARKERS.some((re) => re.test(expr));

const normalized = (source: string): string =>
  stripComments(source).text.replace(/\s+/g, ' ').trim();

/** The files a file imports or re-exports by a relative path (`import type` aside), in the file set: whose SQL its interpolations may build. */
export function opaqueDeps(
  rel: string,
  files: ReadonlyMap<string, string>,
  via: readonly string[] = [],
): string[] {
  const text = stripComments(files.get(rel) ?? '').text;
  const out = new Set<string>(via);
  for (const m of text.matchAll(
    /\b(?:import|export)\s+(?!type\b)[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,
  )) {
    const base = posix.normalize(posix.join(posix.dirname(rel), m[1] ?? ''));
    const file = [base, `${base}.ts`, `${base}/index.ts`].find((f) => files.has(f));
    if (file && file !== rel) out.add(file);
  }
  return [...out].sort();
}

/** 12 hex characters over the comment- and whitespace-free sources of the file and its imports, in order. */
export function opaqueHash(
  rel: string,
  files: ReadonlyMap<string, string>,
  via: readonly string[] = [],
) {
  const h = createHash('sha256');
  for (const f of [rel, ...opaqueDeps(rel, files, via)])
    h.update(`${f}\n${normalized(files.get(f) ?? '')}\n`);
  return h.digest('hex').slice(0, 12);
}

/**
 * A caller-built fragment must be ANDed in as `AND (${fragment})`: its own parentheses keep an `OR` inside
 * it from widening the WHERE, and the conjunction keeps it from being OR-joined. A fragment in a SET or
 * CASE value, or inside a parenthesized group, needs only its own parentheses.
 * `statement` is the expanded text (`(a|b)` marks a ternary branch).
 */
export function fragmentPlacement(statement: string): string[] {
  const spans = opaqueSpans(statement).filter((s) => !isBindMarker(s.expr));
  if (spans.length === 0) return [];
  // Mask the interpolations so their own parentheses do not count.
  let masked = statement;
  for (const { start, end } of spans)
    masked = `${masked.slice(0, start + 2)}${'_'.repeat(end - start - 2)}${masked.slice(end)}`;
  // A group with a top-level `|` is a ternary branch, not SQL structure.
  const frames: { open: number; close: number; bar: boolean }[] = [];
  const stack: { open: number; bar: boolean }[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') stack.push({ open: i, bar: false });
    else if (c === '|' && stack.length > 0)
      (stack[stack.length - 1] as { bar: boolean }).bar = true;
    else if (c === ')' && stack.length > 0) {
      const f = stack.pop() as { open: number; bar: boolean };
      frames.push({ ...f, close: i });
    }
  }
  const out: string[] = [];
  for (const { expr, start, end } of spans) {
    const before = masked.slice(0, start).trimEnd();
    if (
      !before.endsWith('(') ||
      !masked
        .slice(end + 1)
        .trimStart()
        .startsWith(')')
    ) {
      out.push(`\${${expr}} is not parenthesized: interpolate it as AND (\${${expr}})`);
      continue;
    }
    const open = before.length - 1;
    const real = frames.filter((f) => f.open < open && f.close > end && !f.bar).length;
    if (real > 0 || !/\bWHERE\b/i.test(before)) continue;
    // Walk back over ternary branches and NOT to the connective.
    let prior = before.slice(0, open);
    for (;;) {
      prior = prior.trimEnd();
      const at = prior.length - 1;
      const branch = frames
        .filter((f) => f.bar && f.open < at && f.close > at)
        .sort((a, b) => b.open - a.open)[0];
      if (prior.endsWith('|') && branch) prior = prior.slice(0, branch.open + 1);
      if (frames.some((f) => f.bar && f.open === prior.length - 1)) prior = prior.slice(0, -1);
      else if (prior.endsWith('|')) prior = prior.slice(0, -1);
      else if (/\bNOT$/i.test(prior)) prior = prior.slice(0, -3);
      else break;
    }
    if (!/\b(?:AND|WHERE)$/i.test(prior))
      out.push(
        `\${${expr}} is not ANDed into the WHERE (OR-joined or bare): write AND (\${${expr}})`,
      );
  }
  return out;
}

/** Findings for the opaque interpolations of a pinned file; `exprs` are those of its raw writes. */
export function opaqueFindings(
  rel: string,
  exprs: readonly string[],
  entry: OpaqueEntry | undefined,
  files?: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const expr of new Set(exprs.filter((e) => !isBindMarker(e))))
    if (!entry?.exprs.includes(expr))
      out.push(
        `a pinned statement interpolates \${${expr}}, which the pin cannot see: write its terms as a literal constant, or review it in OPAQUE_ALLOWLIST`,
      );
  if (entry && files) {
    const now = opaqueHash(rel, files, entry.via);
    if (now !== entry.hash)
      out.push(
        `the source behind its opaque interpolations changed (${now}, reviewed ${entry.hash}): review ${[rel, ...opaqueDeps(rel, files, entry.via)].join(', ')} and re-pin OPAQUE_ALLOWLIST`,
      );
  }
  return out;
}
