// Fails when an SDK method starts with a verb nobody reviewed, or an SDK name or reference description
// uses UK spelling or breaks the sentence form (tools/lib/vocabulary.ts). Run in `npm run check:rules`.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SdkNames } from './lib/openapi-ratchet.ts';
import { vocabularyFailures } from './lib/vocabulary.ts';

const root = resolve(import.meta.dirname, '..');
const read = (file: string): unknown => JSON.parse(readFileSync(resolve(root, file), 'utf8'));

const descriptions: Record<string, string> = {};
for (const file of readdirSync(resolve(root, 'docs/api/reference'))) {
  const entries = read(`docs/api/reference/${file}`) as Record<string, { description?: string }>;
  for (const [id, entry] of Object.entries(entries))
    if (entry.description) descriptions[id] = entry.description;
}

const failures = vocabularyFailures(read('docs/api/sdk-names.json') as SdkNames, descriptions);
if (failures.length) {
  console.error(`check-vocabulary: ${failures.length} failure(s)\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('check-vocabulary: ok');
