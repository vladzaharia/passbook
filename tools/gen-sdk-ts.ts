// Generates sdk/typescript/src/generated from docs/api/openapi.v1.json and docs/api/sdk-names.json.
// `node tools/gen-sdk-ts.ts` writes; `--check` fails when the committed files differ (run in `npm run check:rules`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { newestApiVersion, tsApiVersionFile } from './lib/sdk-api-version.ts';
import {
  errorCodesFile,
  operationTypesFile,
  resourceFiles,
  resourceTree,
  rootFile,
  schemasFile,
} from './lib/sdk-ts-emit.ts';
import { type OpenApiDoc, type SdkNames, sdkOperations } from './lib/sdk-ts-ops.ts';

const root = resolve(import.meta.dirname, '..');
export const OUT = 'sdk/typescript/src/generated';

/** The codes of docs/api/errors.json. */
export const errorCodes = (catalog: { codes: { code: string }[] }): string[] =>
  catalog.codes.map((c) => c.code);

/** Generated files by path under OUT. */
export function generate(doc: OpenApiDoc, names: SdkNames, codes: string[]): Map<string, string> {
  const ops = sdkOperations(doc, names);
  const files = new Map<string, string>([
    ['schemas.ts', schemasFile(doc.components.schemas)],
    ['error-codes.ts', errorCodesFile(codes)],
    ['api-version.ts', tsApiVersionFile(newestApiVersion())],
    ['operation-types.ts', operationTypesFile(ops, new Set(Object.keys(doc.components.schemas)))],
  ]);
  const tree = resourceTree(ops);
  for (const [name, text] of resourceFiles(tree)) files.set(name, text);
  files.set('root.ts', rootFile(tree));
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
  const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
  const files = generate(
    read('docs/api/openapi.v1.json'),
    read('docs/api/sdk-names.json'),
    errorCodes(read('docs/api/errors.json')),
  );
  const dir = resolve(root, OUT);
  if (process.argv.includes('--check')) {
    const bad = drift(files, dir);
    if (bad.length) {
      console.error(
        `sdk/typescript is out of date: ${bad.join(', ')}. Run: node tools/gen-sdk-ts.ts`,
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
  console.log(`sdk/typescript: ${files.size} files generated`);
}

if (import.meta.main) main();
