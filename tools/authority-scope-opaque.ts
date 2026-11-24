// Interpolations the raw-write fingerprint cannot see into (tools/authority-scope-statements.ts leaves
// them as text). A pinned statement with one would survive any change to the SQL behind it, so each one
// is a finding unless it is a bind-marker list or reviewed here: its exact text, plus a hash of the
// normalized source of the file and the files whose SQL it builds, so editing any of them needs a review.
import { createHash } from 'node:crypto';
import { stripComments } from './authority-scope-statements.ts';

export interface OpaqueEntry {
  reason: string;
  /** Exact whitespace-collapsed texts of the reviewed interpolations. */
  exprs: string[];
  /** Files, besides this one, whose SQL the interpolations build. */
  deps?: string[];
  /** `opaqueHash` of the file and its deps. */
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

/** 12 hex characters over the comment- and whitespace-free sources, in order. */
export function opaqueHash(
  rel: string,
  deps: readonly string[],
  files: ReadonlyMap<string, string>,
) {
  const h = createHash('sha256');
  for (const f of [rel, ...deps]) h.update(`${f}\n${normalized(files.get(f) ?? '')}\n`);
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
    const now = opaqueHash(rel, entry.deps ?? [], files);
    if (now !== entry.hash)
      out.push(
        `the source behind its opaque interpolations changed (${now}, reviewed ${entry.hash}): review ${[rel, ...(entry.deps ?? [])].join(', ')} and re-pin OPAQUE_ALLOWLIST`,
      );
  }
  return out;
}
