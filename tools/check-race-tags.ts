// Scan race interceptors match a comment tag (`scan/race-tags.ts`), never SQL text: a rewrite of a statement
// must not silently disarm a race. Run in `npm run check:rules`. A line that inspects SQL for another reason
// (a shape assertion, a recorder) carries `// sql-shape`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const SCAN = 'src/worker/modules/scan';
const TEST_FILE = /(?:\.test|-fixtures?|-fixture|-test-fixtures)\.ts$/;
const MACHINERY = /new Proxy\(|interceptBatches\(|raceFence\(|afterCandidateRead\(/;
const SQL_NAME = '(?:sql|sqlText|text|query|statement|stmt|prepared)';
const METHOD = String.raw`\.\s*(?:includes|startsWith|endsWith|match|search|test|replace)\s*\(`;
const MATCHERS = [
  new RegExp(String.raw`\b${SQL_NAME}${METHOD}\s*(?!RACE_)`),
  new RegExp(String.raw`/[^/\n]+/[a-z]*\.test\(\s*\w*${SQL_NAME}`, 'i'),
  new RegExp(String.raw`\b${SQL_NAME}\s*\)\s*\.\s*(?:includes|match)\(`),
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (TEST_FILE.test(name)) yield path;
  }
}

/** `file:line` of each SQL-text matcher in a scan test file that builds a race interceptor. */
export function sqlTextMatchers(rel: string, text: string): string[] {
  if (!MACHINERY.test(text)) return [];
  return text.split('\n').flatMap((line, i) => {
    if (line.includes('// sql-shape') || /^\s*(?:\/\/|\*)/.test(line)) return [];
    return MATCHERS.some((m) => m.test(line)) ? [`${rel}:${i + 1}: ${line.trim()}`] : [];
  });
}

if (import.meta.main) {
  const found = [...sources(join(root, SCAN))].flatMap((path) =>
    sqlTextMatchers(relative(root, path), readFileSync(path, 'utf8')),
  );
  if (found.length > 0) {
    console.error(
      `Race interceptors must match a tag from scan/race-tags.ts, not SQL text (mark a non-race inspection with // sql-shape):\n${found.join('\n')}`,
    );
    process.exit(1);
  }
}
