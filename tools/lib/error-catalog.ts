// Extracts the API's error codes from source (no runtime), and the webhook event catalog. Pure but for file reads.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isInternalCode } from '../../src/worker/platform/internal-codes.ts';

const root = resolve(import.meta.dirname, '../..');
const WORKER = join(root, 'src/worker');
const CODE = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;

export interface CatalogCode {
  code: string;
  /** Every status the code is raised with, the one raised at the most sites first (ties: the lower status). */
  statuses: number[];
  /** Directories under src/worker/modules (or the top-level worker directory) that throw it. */
  modules: string[];
}
export interface ErrorCatalog {
  codes: CatalogCode[];
}

/** Codes the catalog carries before any source scan: PX7 implements the two sandbox ones; S7 the staff PIN one; release T2 the review one. */
const DECLARED: Record<string, { status: number; module: string }> = {
  SANDBOX_QUOTA: { status: 403, module: 'sandbox' },
  SANDBOX_PREVIEW_ONLY: { status: 409, module: 'sandbox' },
  // Thrown through classes whose code is not a literal at the `new` site (platform/errors-denial.ts).
  IDP_SIGN_IN_REQUIRED: { status: 403, module: 'platform' },
  STEP_UP_REQUIRED: { status: 403, module: 'platform' },
  PASSKEY_REQUIRED: { status: 403, module: 'sign-in' },
  IDP_EMAIL_NOT_PRIMARY: { status: 403, module: 'sign-in' },
  STAFF_NAME_REQUIRED: { status: 409, module: 'scan' },
  TEMPLATE_REVIEW_REQUIRED: { status: 409, module: 'templates' },
  VALIDATION: { status: 422, module: 'platform' },
  INTERNAL: { status: 500, module: 'platform' },
  HTTP_ERROR: { status: 400, module: 'platform' },
  NOT_FOUND: { status: 404, module: 'platform' },
  PAYLOAD_TOO_LARGE: { status: 413, module: 'platform' },
  RATE_LIMITED: { status: 429, module: 'platform' },
};

/** `authorityDenied` reason to status, for `codes: { stale: 'X' }` overrides. */
const REASON_STATUS: Record<string, number> = {
  org: 403,
  actor: 403,
  staff: 409,
  config: 409,
  lineage: 409,
  release: 409,
  retention: 409,
  entitlement: 403,
  limit: 403,
  stale: 409,
  proof: 500,
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const moduleOf = (file: string): string => {
  const parts = relative(WORKER, file).split('/');
  return parts[0] === 'modules' ? (parts[1] ?? 'modules') : (parts[0] ?? '');
};

/** Index just past the `)` that closes the call whose `(` is at `open`. Strings are skipped. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return src.length;
}

/** Class name to HTTP status, from `super(code, 404, ...)` and `extends` chains across the worker. */
function statusByClass(sources: string[]): Map<string, number> {
  const map = new Map<string, number>([['AppError', 500]]);
  const classes = sources.flatMap((s) =>
    [...s.matchAll(/class (\w+) extends (\w+)[^{]*\{([\s\S]*?)\n\}/g)].map((m) => ({
      name: m[1] ?? '',
      parent: m[2] ?? '',
      body: m[3] ?? '',
    })),
  );
  for (let pass = 0; pass < 4; pass++) {
    for (const c of classes) {
      const own = /super\(\s*(?:code|'[A-Z_]+')\s*,\s*(\d{3})/.exec(c.body)?.[1];
      const status = own ? Number(own) : map.get(c.parent);
      if (status && !map.has(c.name)) map.set(c.name, status);
    }
  }
  return map;
}

export function buildErrorCatalog(): ErrorCatalog {
  const paths = files(WORKER).sort();
  const sources = paths.map((p) => readFileSync(p, 'utf8'));
  const statuses = statusByClass(sources);
  const found = new Map<string, { statuses: Map<number, number>; modules: Set<string> }>();
  const add = (code: string, status: number, module: string): void => {
    const e = found.get(code) ?? { statuses: new Map(), modules: new Set() };
    e.statuses.set(status, (e.statuses.get(status) ?? 0) + 1);
    e.modules.add(module);
    found.set(code, e);
  };
  for (const [code, d] of Object.entries(DECLARED)) add(code, d.status, d.module);
  paths.forEach((file, i) => {
    const src = sources[i] ?? '';
    const mod = moduleOf(file);
    const isErrors = file.endsWith('platform/errors.ts');
    // `new XError(msg, 'CODE')` and `new AppError('CODE', status, msg)`.
    for (const m of src.matchAll(/new (\w+Error)\(/g)) {
      const name = m[1] ?? '';
      const status = statuses.get(name);
      if (!status) continue;
      const args = src.slice(
        (m.index ?? 0) + m[0].length - 1,
        closeOf(src, (m.index ?? 0) + m[0].length - 1),
      );
      const explicit =
        name === 'AppError' ? Number(/,\s*(\d{3})\b/.exec(args)?.[1]) || status : status;
      for (const c of args.matchAll(CODE)) add(c[1] ?? '', explicit, mod);
    }
    // Class constructors with a default code: `code = 'X'`.
    for (const m of src.matchAll(/class (\w+) extends \w+[^{]*\{[\s\S]*?code = '([A-Z_]+)'/g)) {
      const status = statuses.get(m[1] ?? '');
      if (status) add(m[2] ?? '', status, mod);
    }
    if (isErrors) {
      for (const m of src.matchAll(/\?\? '([A-Z_]+)'/g)) {
        const before = src.slice(0, m.index ?? 0);
        const last = [...before.matchAll(/case '(\w+)':|(default):/g)].at(-1);
        add(m[1] ?? '', REASON_STATUS[last?.[1] ?? ''] ?? 403, mod);
      }
      for (const m of src.matchAll(/'(AUTHORITY_UNPROVEN|FEATURE_UNCHECKED)'/g))
        add(m[1] ?? '', 500, mod);
    }
    // `codes: { stale: 'PASS_CHANGED' }` overrides of authorityDenied.
    for (const m of src.matchAll(/codes:\s*\{([^}]*)\}/g))
      for (const e of (m[1] ?? '').matchAll(/(\w+):\s*'([A-Z][A-Z0-9_]+)'/g))
        add(e[2] ?? '', REASON_STATUS[e[1] ?? ''] ?? 403, mod);
  });
  const codes = [...found.entries()]
    .filter(([code]) => !isInternalCode(code))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, e]) => ({
      code,
      statuses: [...e.statuses]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([status]) => status),
      modules: [...e.modules].sort(),
    }));
  return { codes };
}
