// File size limit and test-only module boundary for src/. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const MAX_LINES = 330;

/** Files allowed over the limit. Every entry names an owner and a reason. */
export const ALLOWLIST: Record<string, { owner: string; reason: string }> = {};

const TEST_FILE = /\.test\.tsx?$/;
/** Modules that exist for tests; production code must not import them. */
const TEST_ONLY =
  /(^|\/)(test-kit|test-support|test-oidc|test-utils|test-fixtures|testing|[a-z0-9-]*fixtures?|fixture-[a-z-]+|rules-helpers|load-dir)(\/index)?\.tsx?$/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|css)$/.test(name)) yield path;
  }
}

const isGenerated = (rel: string) =>
  rel.startsWith('src/generated/') || rel.endsWith('routeTree.gen.ts');

export function tooLong(rel: string, text: string): string | null {
  if (TEST_FILE.test(rel) || isGenerated(rel) || rel in ALLOWLIST) return null;
  const lines = text.trimEnd().split('\n').length;
  return lines > MAX_LINES ? `${rel} has ${lines} lines (limit ${MAX_LINES})` : null;
}

export function testOnlyImports(rel: string, text: string): string[] {
  if (TEST_FILE.test(rel) || TEST_ONLY.test(rel) || !/\.tsx?$/.test(rel)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s+'(\.{1,2}\/[^']+)'/g)) {
    const target = relative(root, resolve(dirname(join(root, rel)), m[1] ?? ''));
    if (TEST_ONLY.test(target)) found.push(`${rel} imports test-only module ${m[1]}`);
  }
  return found;
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const file of sources(join(root, 'src'))) {
    const rel = relative(root, file);
    const text = readFileSync(file, 'utf8');
    const long = tooLong(rel, text);
    if (long) problems.push(long);
    problems.push(...testOnlyImports(rel, text));
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
}
