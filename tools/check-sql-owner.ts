// SQL lives in repo*.ts and the platform owner files only. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from './authority-scope-statements.ts';

const root = resolve(import.meta.dirname, '..');
const SQL =
  /\b(?:SELECT\s[^`'"]*\sFROM\s|INSERT\s+(?:OR\s+\w+\s+)?INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s)/;
const ALLOWED =
  /(^|\/)repo[a-z0-9-]*\.ts$|\.test\.tsx?$|(^|\/)test-kit\.ts$|-test-fixtures\.ts$|(^|\/)templates\/testing\.ts$|src\/worker\/platform\/(db|counters|workflow-runs|batched|authority[a-z-]*)\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

// REPLACE deletes and reinserts, which skips the pass type trigger and cascades registrations away.
const IDENTITY_REPLACE =
  /\b(?:INSERT\s+OR\s+REPLACE\s+INTO|REPLACE\s+INTO|UPDATE\s+OR\s+REPLACE)\s+signing_identities\b/i;

export function replaceOnIdentities(rel: string, text: string): string | null {
  if (/\.test\.tsx?$/.test(rel) || !rel.startsWith('src/worker/')) return null;
  return IDENTITY_REPLACE.test(text) ? `${rel} replaces rows of signing_identities` : null;
}

export function sqlOutsideRepo(rel: string, text: string): string | null {
  if (ALLOWED.test(rel) || !rel.startsWith('src/worker/')) return null;
  return SQL.test(text) ? `${rel} contains SQL outside a repo file` : null;
}

// A bound parameter that switches a filter off defeats index use and lets a null drop a tenant filter.
// Build the WHERE from the filters that are present instead. The patterns cover a null test of a bind in
// either order, `?NNN`, ISNULL / COALESCE / IFNULL of a bind, an empty-string sentinel and CASE WHEN ?.
const P = String.raw`\?\d*`;
const OPTIONAL_BIND = [
  new RegExp(String.raw`${P}\s+IS\s+(?:NOT\s+)?NULL\b`, 'gi'),
  new RegExp(String.raw`\bNULL\s+IS\s+${P}`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>)\s*NULL\b|\bNULL\s*(?:=|==|!=|<>)\s*${P}`, 'gi'),
  new RegExp(String.raw`\b(?:ISNULL|COALESCE|IFNULL)\s*\(\s*${P}\s*[,)]`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>)\s*''|''\s*(?:=|==|!=|<>)\s*${P}(?!\d)`, 'gi'),
  new RegExp(String.raw`\bCASE\s+WHEN\s+${P}`, 'gi'),
];
const TEST_FILE =
  /\.test\.tsx?$|(^|\/)(?:test-kit|test-support|test-utils|testing|[a-z0-9-]*(?:test-support|fixtures?))\.tsx?$/;

const SET_VALUE = 'a SET or SELECT value (COALESCE / CASE on a bound value), not a filter';
const CLOSED_GUARD =
  'a bound flag inside a disjunct or a fail-closed non-null check; no tenant filter depends on it';
/** Reviewed lines per file: more than the count is a finding. */
export const OPTIONAL_BIND_ALLOWED: Record<string, { lines: number; reason: string }> = {
  'src/worker/modules/broadcasts/repo.ts': { lines: 2, reason: SET_VALUE },
  'src/worker/modules/developer/repo-request-log.ts': { lines: 3, reason: SET_VALUE },
  'src/worker/modules/identities/repo-runs.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/message-rules/repo.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/passes/repo-authority.ts': {
    lines: 1,
    reason: '`? IS NOT NULL` asserts the bound org id is present, so a null fails closed',
  },
  'src/worker/modules/scan/override-scope.ts': { lines: 1, reason: CLOSED_GUARD },
  'src/worker/modules/scan/repo-act-claim.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/scan/repo-admission.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/scan/repo-device.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/scan/repo-scans.ts': { lines: 1, reason: SET_VALUE },
  'src/worker/modules/scan/repo-watch-cover.ts': { lines: 1, reason: CLOSED_GUARD },
  'src/worker/modules/wallet-providers/repo-google-managed.ts': { lines: 2, reason: SET_VALUE },
  'src/worker/modules/wallet-providers/repo-instance-desired.ts': { lines: 2, reason: SET_VALUE },
  'src/worker/modules/wallet-providers/repo-instance-mutations.ts': { lines: 2, reason: SET_VALUE },
  'src/worker/platform/workflow-runs.ts': { lines: 2, reason: SET_VALUE },
};

/** `file:line` of each optional-bind predicate in worker code; comments, tests and fixtures are not checked. */
export function optionalBindPredicate(rel: string, text: string): string[] {
  if (TEST_FILE.test(rel) || !rel.startsWith('src/worker/')) return [];
  const { text: code } = stripComments(text);
  const lines = new Set<number>();
  for (const re of OPTIONAL_BIND)
    for (const m of code.matchAll(re)) lines.add(code.slice(0, m.index ?? 0).split('\n').length);
  const allowed = OPTIONAL_BIND_ALLOWED[rel]?.lines ?? 0;
  return [...lines]
    .sort((a, b) => a - b)
    .slice(allowed)
    .map(
      (line) =>
        `${rel}:${line} binds a parameter to switch a filter off; build the WHERE from the filters that are present`,
    );
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of sources(join(root, 'src/worker'))) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');
    for (const found of [sqlOutsideRepo(rel, text), replaceOnIdentities(rel, text)])
      if (found) problems.push(found);
    problems.push(...optionalBindPredicate(rel, text));
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}
