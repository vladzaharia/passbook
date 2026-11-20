// Agreement checks between the OpenAPI snapshot, the error catalog and the DevEx guide. Pure: no I/O.
import type { Doc } from './openapi-diff.ts';

export interface Guide {
  [code: string]: { title?: string; when?: string; fix?: string; retryable?: unknown };
}
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

type Json = Record<string, unknown>;

/** Codes that any key-callable operation can return, from `x-codes`. */
function keyReachableCodes(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const item of Object.values(doc.paths ?? {}))
    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      const security = Array.isArray(op?.security) ? (op.security as Json[]) : [];
      if (op && security.some((s) => 'apiKey' in s))
        for (const c of (op['x-codes'] as string[] | undefined) ?? []) out.add(c);
    }
  return out;
}

export function developerFailures(input: {
  doc: Doc;
  catalog: string[];
  guide: Guide;
  generated: Record<string, { on: string; fresh: string }>;
}): string[] {
  const out: string[] = [];
  for (const [file, { on, fresh }] of Object.entries(input.generated))
    if (on !== fresh) out.push(`${file} is stale; run npm run gen`);
  for (const [path, item] of Object.entries(input.doc.paths ?? {}))
    for (const m of METHODS) {
      const op = item[m] as Json | undefined;
      if (op && !Array.isArray(op['x-codes'])) out.push(`${m.toUpperCase()} ${path}: no x-codes`);
    }
  const known = new Set(input.catalog);
  for (const code of keyReachableCodes(input.doc)) {
    if (!known.has(code)) out.push(`${code}: in x-codes but not in errors.json`);
    if (!input.guide[code])
      out.push(`${code}: key-reachable code has no entry in error-guide.json`);
  }
  for (const [code, e] of Object.entries(input.guide)) {
    if (!known.has(code)) out.push(`${code}: error-guide.json entry for an unknown code`);
    for (const f of ['title', 'when', 'fix'] as const)
      if (!e[f]?.trim()) out.push(`${code}: guide entry needs ${f}`);
    if (typeof e.retryable !== 'boolean')
      out.push(`${code}: guide entry needs retryable (boolean)`);
  }
  return out;
}
