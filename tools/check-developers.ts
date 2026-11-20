// Fails when a key-reachable error code has no guide entry, an operation has no x-codes, or a generated
// catalog file is stale. Run in `npm run check:rules`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { developerFailures, type Guide } from './lib/developers-check.ts';
import { buildErrorCatalogFile, buildEventCatalog } from './lib/error-catalog-files.ts';
import type { Doc } from './lib/openapi-diff.ts';
import { buildWebhookVectors } from './lib/webhook-vectors.ts';

const root = resolve(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(resolve(root, file), 'utf8');

const failures = developerFailures({
  doc: JSON.parse(read('docs/api/openapi.v1.json')) as Doc,
  catalog: (JSON.parse(read('docs/api/errors.json')) as { codes: { code: string }[] }).codes.map(
    (c) => c.code,
  ),
  guide: JSON.parse(read('docs/api/error-guide.json')) as Guide,
  generated: {
    'docs/api/errors.json': { on: read('docs/api/errors.json'), fresh: buildErrorCatalogFile() },
    'docs/api/webhook-events.json': {
      on: read('docs/api/webhook-events.json'),
      fresh: buildEventCatalog(),
    },
    'docs/api/webhook-vectors.json': {
      on: read('docs/api/webhook-vectors.json'),
      fresh: await buildWebhookVectors(),
    },
  },
});
if (failures.length) {
  console.error(`check-developers: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('check-developers: ok');
