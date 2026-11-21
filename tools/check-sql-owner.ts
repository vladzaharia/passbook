// SQL lives in repo*.ts and the platform owner files only. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of sources(join(root, 'src/worker'))) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');
    for (const found of [sqlOutsideRepo(rel, text), replaceOnIdentities(rel, text)])
      if (found) problems.push(found);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}
