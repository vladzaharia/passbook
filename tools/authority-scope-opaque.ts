// Interpolations the raw-write fingerprint cannot see into (tools/authority-scope-statements.ts leaves
// them as text). A pinned statement with one would survive any change to the SQL behind it, so each one
// is a finding unless it is a bind-marker list or reviewed here: its exact text, plus a hash of the
// normalized source of the file and the files whose SQL it builds (`opaqueDeps`), so editing any of them needs a review.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { stripComments } from './authority-scope-statements.ts';

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

/** Infrastructure and mappers whose edits say nothing about the SQL a pin covers. */
const NOT_SQL = [
  /^src\/worker\/platform\/(?:db|batched|errors)\.ts$/,
  /^src\/shared\/contracts\//,
  /-map\.ts$/,
];

/**
 * The files whose SQL a pinned file's interpolations may build: what it imports by a relative path
 * (value imports only; `import type` and `{ type X }` do not count, nor do `NOT_SQL` files), plus `via`.
 * Only files in the set are resolved, and the set is src/worker, so an import from src/shared or
 * src/passkit is not followed. An import of an import is not followed either: name those in `via`
 * (authority-scope-opaque.test.ts requires every depth-2 value import to be in `via` or ignored).
 */
export function opaqueDeps(
  rel: string,
  files: ReadonlyMap<string, string>,
  via: readonly string[] = [],
): string[] {
  const text = stripComments(files.get(rel) ?? '').text;
  const out = new Set<string>(via);
  for (const m of text.matchAll(
    /\b(?:import|export)\s+(?!type\b)([^;'"]*?)\s*from\s*['"](\.[^'"]+)['"]/g,
  )) {
    const names = /^\{([^}]*)\}$/.exec((m[1] ?? '').trim())?.[1];
    if (names?.split(',').every((n) => /^\s*type\s/.test(n) || n.trim() === '')) continue;
    const base = posix.normalize(posix.join(posix.dirname(rel), m[2] ?? ''));
    const file = [base, `${base}.ts`, `${base}/index.ts`].find((f) => files.has(f));
    if (file && file !== rel && !NOT_SQL.some((re) => re.test(file))) out.add(file);
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
