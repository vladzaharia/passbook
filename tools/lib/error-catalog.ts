// Extracts the API's error codes from source (no runtime), and the webhook event catalog. Pure but for file reads.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isInternalCode } from '../../src/worker/platform/internal-codes.ts';

const root = resolve(import.meta.dirname, '../..');
const WORKER = join(root, 'src/worker');
const CODE = /'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)'/g;

export interface CatalogCode {
  code: string;
  /** Every status the code is raised with, the one to show first: the most common raise site; on a tie the 5xx when the tie spans 4xx and 5xx, else the lower. */
  statuses: number[];
  /** The statuses tied for most common, ascending. Only present when there is a tie. */
  primary?: number[];
  /** Directories under src/worker/modules (or the top-level worker directory) that throw it. */
  modules: string[];
}
/** One raise site, for tests that pin where a second status comes from. */
export interface RaiseSite {
  code: string;
  status: number;
  /** Relative to src/worker. */
  file: string;
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

/** What the file parser refuses (`src/shared/tabular`): the connection file routes answer with its code (files-errors.ts). */
const FILE_PARSER_CODES: Record<string, number> = {
  FILE_TOO_LARGE: 413,
  FILE_BAD_POINTER: 400,
  FILE_SHEET_NOT_FOUND: 400,
  ...Object.fromEntries(
    [
      'FILE_FORMAT_UNSUPPORTED',
      'FILE_MACRO',
      'FILE_ENCODING',
      'FILE_EMPTY',
      'FILE_DAMAGED',
      'FILE_ARCHIVE_LIMIT',
      'FILE_XML_UNSAFE',
      'FILE_TOO_MANY_ROWS',
      'FILE_TOO_MANY_COLUMNS',
      'FILE_TOO_MANY_CELLS',
      'FILE_CELL_TOO_LONG',
      'FILE_LINE_TOO_LONG',
      'FILE_HEADER_MISSING',
      'FILE_HEADER_TOO_LONG',
      'FILE_HEADER_DUPLICATE',
      'FILE_ROW_SHAPE',
      'FILE_JSON_TOO_DEEP',
      'FILE_NOT_RECORDS',
      'FILE_RECORDS_NOT_FOUND',
    ].map((code) => [code, 422]),
  ),
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
  // FileRejectedError picks its status from the parser code (`statusOf`), so a literal at a `new` site is the 422 kind.
  const map = new Map<string, number>([
    ['AppError', 500],
    ['FileRejectedError', 422],
  ]);
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

export function buildErrorCatalog(sites?: RaiseSite[]): ErrorCatalog {
  const paths = files(WORKER).sort();
  const sources = paths.map((p) => readFileSync(p, 'utf8'));
  const statuses = statusByClass(sources);
  const found = new Map<string, { statuses: Map<number, number>; modules: Set<string> }>();
  let at = '(declared)';
  const add = (code: string, status: number, module: string): void => {
    sites?.push({ code, status, file: at });
    const e = found.get(code) ?? { statuses: new Map(), modules: new Set() };
    e.statuses.set(status, (e.statuses.get(status) ?? 0) + 1);
    e.modules.add(module);
    found.set(code, e);
  };
  for (const [code, d] of Object.entries(DECLARED)) add(code, d.status, d.module);
  for (const [code, status] of Object.entries(FILE_PARSER_CODES)) add(code, status, 'connections');
  paths.forEach((file, i) => {
    const src = sources[i] ?? '';
    at = relative(WORKER, file);
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
    // Class constructors that pass a literal code up: `super('message', 'X')`, as errors-denial.ts does.
    for (const m of src.matchAll(/class (\w+) extends \w+[^{]*\{([\s\S]*?)\n\}/g)) {
      const status = statuses.get(m[1] ?? '');
      const body = m[2] ?? '';
      const at = body.indexOf('super(');
      if (!status || at < 0) continue;
      for (const c of body.slice(at, closeOf(body, at + 5)).matchAll(CODE))
        add(c[1] ?? '', status, mod);
    }
    // Class constructors with a default code: `code = 'X'`.
    for (const m of src.matchAll(/class (\w+) extends \w+[^{]*\{([\s\S]*?)\n\}/g)) {
      const code = /code = '([A-Z_]+)'/.exec(m[2] ?? '')?.[1];
      const status = statuses.get(m[1] ?? '');
      if (code && status) add(code, status, mod);
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
    .map(([code, e]) => ({ code, ...rankStatuses(e.statuses), modules: [...e.modules].sort() }));
  return { codes };
}

/** Most common first. A tie has no single answer: it is kept as `primary`, and one number is picked for places that need one. */
function rankStatuses(counts: Map<number, number>): Pick<CatalogCode, 'statuses' | 'primary'> {
  const top = Math.max(...counts.values());
  const tied = [...counts]
    .filter(([, n]) => n === top)
    .map(([status]) => status)
    .sort((a, b) => a - b);
  const spansClasses = tied.some((s) => s >= 500) && tied.some((s) => s < 500);
  const pick = spansClasses ? (tied.at(-1) as number) : (tied[0] as number);
  const rest = [...counts]
    .filter(([status]) => status !== pick)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([status]) => status);
  return { statuses: [pick, ...rest], ...(tied.length > 1 ? { primary: tied } : {}) };
}
