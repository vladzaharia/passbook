// Writes docs/developers/snippets/generated/<lang>/<operationId>.<ext> for every operation a key may call,
// in curl, TypeScript, Python and Go: the same text the portal's reference pages show.
// `node tools/gen-snippets.ts` writes; `--check` fails when the committed files differ (run in `npm run check:rules`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadInputs } from '../src/web/developers/model/load.ts';
import { samplesFor } from '../src/web/developers/model/samples.ts';
import { buildSite } from '../src/web/developers/model/site.ts';

const root = resolve(import.meta.dirname, '..');
export const OUT = 'docs/developers/snippets/generated';
const EXT = { curl: 'sh', ts: 'ts', py: 'py', go: 'go' } as const;

/** Generated files by path under OUT. */
export function generate(rootDir = root): Map<string, string> {
  const site = buildSite(loadInputs(rootDir));
  const files = new Map<string, string>();
  for (const page of site.pages)
    for (const op of page.ops)
      for (const s of samplesFor(op, site.baseUrl))
        files.set(`${s.lang}/${op.operationId}.${EXT[s.lang as keyof typeof EXT]}`, `${s.code}\n`);
  return files;
}

function onDisk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

/** Paths that differ from `files`, and paths on disk that no longer belong. */
export function drift(files: Map<string, string>, dir: string): string[] {
  const stale = onDisk(dir).filter((p) => !files.has(p));
  const changed = [...files].filter(
    ([p, text]) => !existsSync(join(dir, p)) || readFileSync(join(dir, p), 'utf8') !== text,
  );
  return [...changed.map(([p]) => p), ...stale];
}

function main(): void {
  const files = generate();
  const dir = resolve(root, OUT);
  if (process.argv.includes('--check')) {
    const bad = drift(files, dir);
    if (bad.length) {
      console.error(
        `docs/developers/snippets is out of date (${bad.length}): ${bad.slice(0, 5).join(', ')}. Run: node tools/gen-snippets.ts`,
      );
      process.exit(1);
    }
    return;
  }
  for (const p of onDisk(dir)) if (!files.has(p)) rmSync(join(dir, p));
  for (const [p, text] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  console.log(`snippets: ${files.size} files generated`);
}

if (import.meta.main) main();
