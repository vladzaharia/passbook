// Scan race interceptors match a comment tag (`scan/race-tags.ts`, `platform/race-tag.ts`), never SQL text: a rewrite of a statement
// must not silently disarm a race. Run in `npm run check:rules`. A line that inspects SQL for another reason
// (a shape assertion, a recorder) carries `// sql-shape`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const WORKER = 'src/worker';
// Test files here build race interceptors; the other modules' SQL-text recorders and fences are out of scope.
const RACE_DIRS = [
  'src/worker/modules/scan/',
  'src/worker/modules/templates/',
  'src/worker/platform/',
];
const TAG_FILES = ['src/worker/modules/scan/race-tags.ts', 'src/worker/platform/race-tag.ts'];
const TEST_FILE = /(?:\.test|-fixtures?|-fixture|-test-fixtures)\.ts$/;
const MACHINERY = /new Proxy\(|interceptBatches\(|raceFence\(|afterCandidateRead\(/;
const SQL_NAME = String.raw`\w*(?:[sS]ql|SQL|[tT]ext|[qQ]uery|[sS]tatement|[sS]tmt|[pP]repared)\w*`;
const METHOD = String.raw`\.\s*(?:includes|startsWith|endsWith|match|search|test|replace)\s*\(`;
const MATCHERS = [
  new RegExp(String.raw`\b${SQL_NAME}${METHOD}\s*(?!\s*(?:RACE_|\w*[tT]ag\b))`),
  new RegExp(String.raw`/[^/\n]+/[a-z]*\.test\(\s*\w*${SQL_NAME}`, 'i'),
  new RegExp(String.raw`\b${SQL_NAME}\s*\)\s*\.\s*(?:includes|match)\(`),
];

const EXPORT = /^export const (RACE_\w+) = '([^']*)'/gm;

/** Every exported tag with its value, from the tag files. */
export function tagsOf(files: Record<string, string>): { name: string; value: string }[] {
  return Object.values(files).flatMap((text) =>
    [...text.matchAll(EXPORT)].map((m) => ({ name: m[1] as string, value: m[2] as string })),
  );
}

/** Tags with a duplicate value, no production use, or no test use. `files` maps path to text. */
export function tagProblems(files: Record<string, string>, tagFiles: string[]): string[] {
  const defs = Object.fromEntries(Object.entries(files).filter(([f]) => tagFiles.includes(f)));
  const tags = tagsOf(defs);
  const used = Object.entries(files).filter(([f]) => !tagFiles.includes(f));
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const { name, value } of tags) {
    const other = seen.get(value);
    if (other) out.push(`${name} and ${other} share the value ${value}`);
    seen.set(value, name);
    const word = new RegExp(`\\b${name}\\b`);
    const hits = used.filter(([, text]) => word.test(text));
    if (!hits.some(([f]) => !TEST_FILE.test(f))) out.push(`${name} has no production use`);
    if (!hits.some(([f]) => TEST_FILE.test(f))) out.push(`${name} has no test use`);
  }
  return out;
}

/** `file:line` of each SQL-text matcher in a scan test file that builds a race interceptor. */
export function sqlTextMatchers(rel: string, text: string): string[] {
  if (!MACHINERY.test(text)) return [];
  return text.split('\n').flatMap((line, i) => {
    if (line.includes('// sql-shape') || /^\s*(?:\/\/|\*)/.test(line)) return [];
    return MATCHERS.some((m) => m.test(line)) ? [`${rel}:${i + 1}: ${line.trim()}`] : [];
  });
}

function* allSources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* allSources(path);
    else if (name.endsWith('.ts')) yield path;
  }
}

if (import.meta.main) {
  const files = Object.fromEntries(
    [...allSources(join(root, WORKER))].map((p) => [relative(root, p), readFileSync(p, 'utf8')]),
  );
  const found = Object.entries(files)
    .filter(([f]) => TEST_FILE.test(f) && RACE_DIRS.some((d) => f.startsWith(d)))
    .flatMap(([f, text]) => sqlTextMatchers(f, text));
  const problems = tagProblems(files, TAG_FILES);
  if (problems.length > 0) {
    console.error(
      `Race tags must be unique and used by production code and a test:\n${problems.join('\n')}`,
    );
    process.exit(1);
  }
  if (found.length > 0) {
    console.error(
      `Race interceptors must match a tag from scan/race-tags.ts, not SQL text (mark a non-race inspection with // sql-shape):\n${found.join('\n')}`,
    );
    process.exit(1);
  }
}
