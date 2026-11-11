// SQL lives in repo*.ts and the platform owner files only. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const SQL =
  /\b(?:SELECT\s[^`'"]*\sFROM\s|INSERT\s+(?:OR\s+\w+\s+)?INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s)/;
const ALLOWED =
  /(^|\/)repo[a-z0-9-]*\.ts$|\.test\.tsx?$|(^|\/)test-kit\.ts$|src\/worker\/platform\/(db|counters|workflow-runs|batched|authority[a-z-]*)\.ts$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

export function sqlOutsideRepo(rel: string, text: string): string | null {
  if (ALLOWED.test(rel) || !rel.startsWith('src/worker/')) return null;
  return SQL.test(text) ? `${rel} contains SQL outside a repo file` : null;
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of sources(join(root, 'src/worker'))) {
    const rel = relative(root, file);
    const found = sqlOutsideRepo(rel, readFileSync(file, 'utf8'));
    if (found) problems.push(found);
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}
