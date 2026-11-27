// SQL lives in repo*.ts and the platform owner files only. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { stripComments } from './authority-scope-statements.ts';
import { OPTIONAL_BIND_ALLOWED } from './sql-optional-bind-allowlist.ts';

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
// either order (also through `(SELECT ?)`), `?NNN`, ISNULL / COALESCE / IFNULL / NULLIF of a bind, an
// empty-string sentinel, a bind compared with a literal (`? = 'all'`, `? > 0`), a bare bind beside OR and
// CASE WHEN ?.
const P = String.raw`\?\d*`;
const OPTIONAL_BIND = [
  new RegExp(String.raw`${P}\s+IS\s+(?:NOT\s+)?NULL\b`, 'gi'),
  new RegExp(String.raw`\bNULL\s+IS\s+${P}`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>)\s*NULL\b|\bNULL\s*(?:=|==|!=|<>)\s*${P}`, 'gi'),
  new RegExp(String.raw`\b(?:ISNULL|COALESCE|IFNULL)\s*\(\s*${P}\s*[,)]`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>)\s*''|''\s*(?:=|==|!=|<>)\s*${P}(?!\d)`, 'gi'),
  new RegExp(String.raw`\bCASE\s+WHEN\s+${P}`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>)\s*[01]\b`, 'gi'),
  new RegExp(String.raw`\(\s*SELECT\s+${P}\s*\)\s+IS\s+(?:NOT\s+)?NULL\b`, 'gi'),
  new RegExp(String.raw`\bNULLIF\s*\(\s*${P}\s*,`, 'gi'),
  new RegExp(String.raw`${P}\s*(?:=|==|!=|<>|<=?|>=?)\s*(?:'[^']*'|-?\d)`, 'gi'),
  new RegExp(String.raw`(?:\(|\bOR\b|\bAND\b|\bWHERE\b)\s*${P}\s*\bOR\b`, 'gi'),
  new RegExp(String.raw`\bOR\b\s*${P}\s*(?:\)|\bAND\b|\bOR\b)`, 'gi'),
  // A bind interpolated through a helper (`${p(x)}`, `${b.bind(x)}`); column helpers render names, not binds.
  /\$\{\s*(?:\w+\.)*(?:p|bind)\([^{}]*\)\s*\}\s+IS\s+(?:NOT\s+)?NULL\b/gi,
];
const TEST_FILE =
  /\.test\.tsx?$|(^|\/)(?:test-kit|test-support|test-utils|testing|[a-z0-9-]*(?:test-support|fixtures?))\.tsx?$/;

/** `file:line` of each optional-bind predicate in worker code; comments, tests and fixtures are not checked. */
export function optionalBindPredicate(rel: string, text: string): string[] {
  if (TEST_FILE.test(rel) || !rel.startsWith('src/worker/')) return [];
  const { text: code } = stripComments(text);
  const found = new Map<number, string>();
  for (const re of OPTIONAL_BIND)
    for (const m of code.matchAll(re)) {
      const before = code.slice(0, m.index ?? 0);
      const line = before.split('\n').length;
      const lineText = code.split('\n')[line - 1] ?? '';
      found.set(line, lineText.replace(/\s+/g, ' ').trim());
    }
  // Reviewed lines are pinned by their text, so a new predicate beside one still fails, at its own line.
  const allowed = [...(OPTIONAL_BIND_ALLOWED[rel] ?? [])];
  const out: string[] = [];
  for (const [line, lineText] of [...found].sort((a, b) => a[0] - b[0])) {
    const at = allowed.findIndex((a) => a.text === lineText);
    if (at !== -1) allowed.splice(at, 1);
    else
      out.push(
        `${rel}:${line} binds a parameter to switch a filter off; build the WHERE from the filters that are present`,
      );
  }
  return out;
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
