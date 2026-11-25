// Generates the typed half of sdk/go from docs/api/openapi.v1.json and docs/api/sdk-names.json:
// types_gen.go, resources_gen.go and the table-driven ops_gen_test.go.
// `node tools/gen-sdk-go.ts` writes; `--check` fails when the committed files differ (run in `npm run check:rules`).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drift, writeFiles } from './lib/gen-files.ts';
import { goApiVersionFile, newestApiVersion } from './lib/sdk-api-version.ts';
import { GoTypes, planOps, resourcesFile, resourceTree, typesFile } from './lib/sdk-go-emit.ts';
import { testFile } from './lib/sdk-go-test-emit.ts';
import { Models } from './lib/sdk-model.ts';
import { type OpenApiDoc, type SdkNames, sdkOperations } from './lib/sdk-ts-ops.ts';

const root = resolve(import.meta.dirname, '..');
export const OUT = 'sdk/go';

/** Generated files by path under OUT. */
export function generate(doc: OpenApiDoc, names: SdkNames): Map<string, string> {
  const models = new Models(doc.components.schemas);
  const plan = planOps(models, sdkOperations(doc, names));
  const types = new GoTypes(models);
  return new Map([
    ['types_gen.go', typesFile(models, types)],
    ['resources_gen.go', resourcesFile(resourceTree(plan), types)],
    ['api_version_gen.go', goApiVersionFile(newestApiVersion())],
    ['ops_gen_test.go', testFile(plan, types, doc.components.schemas)],
  ]);
}

export { drift };

/** Only the `*_gen.go` and `*_gen_test.go` files are ours; the rest of sdk/go is written by hand. */
export const owns = (p: string): boolean => /_gen(_test)?\.go$/.test(p);

function main(): void {
  const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
  const files = generate(read('docs/api/openapi.v1.json'), read('docs/api/sdk-names.json'));
  const dir = resolve(root, OUT);
  if (process.argv.includes('--check')) {
    const bad = drift(files, dir, owns);
    if (bad.length) {
      console.error(`sdk/go is out of date: ${bad.join(', ')}. Run: node tools/gen-sdk-go.ts`);
      process.exit(1);
    }
    return;
  }
  writeFiles(files, dir, owns);
  console.log(`sdk/go: ${files.size} files generated`);
}

if (import.meta.main) main();
