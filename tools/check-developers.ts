// Fails when a key-reachable error code has no guide entry, an operation has no x-codes, or a generated
// catalog file is stale, a changelog entry has no note, versions.json is incomplete, or a guide breaks
// its rules (tools/lib/guides-check.ts). Run in `npm run check:rules`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SDK_STATUS } from '../src/shared/developers-sdk.ts';
import { readGuideFiles } from '../src/web/developers/guide/load.ts';
import { guideExamples, loadInputs } from '../src/web/developers/model/load.ts';
import { buildSite } from '../src/web/developers/model/site.ts';
import { buildDevelopers } from './build-developers.ts';
import { changelogFailures, versionFailures } from './lib/changelog.ts';
import { baseVersions, diffAgainstBase, readPending, readVersions } from './lib/changelog-files.ts';
import { developerFailures, type Guide } from './lib/developers-check.ts';
import { outputFailures } from './lib/developers-output-check.ts';
import { buildErrorCatalogFile, buildEventCatalog } from './lib/error-catalog-files.ts';
import { guideFailures } from './lib/guides-check.ts';
import { knownCodes, opCodesFile } from './lib/op-codes.ts';
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
    'docs/api/operation-codes.json': {
      on: read('docs/api/operation-codes.json'),
      fresh: opCodesFile(knownCodes()),
    },
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
failures.push(
  ...guideFailures(
    readGuideFiles(root),
    guideExamples(resolve(root, 'docs/developers/snippets/guides')),
    buildSite(loadInputs(root)),
  ),
);
// The prerendered portal: a twin for every page, a size budget for each, llms.txt that lists only what exists.
const scratch = mkdtempSync(join(tmpdir(), 'check-developers-'));
try {
  failures.push(
    ...outputFailures((await buildDevelopers({ out: scratch, head: '' })).built, SDK_STATUS.cli),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const changed = diffAgainstBase(root);
const spec = JSON.parse(readFileSync(resolve(root, 'docs/api/openapi.v1.json'), 'utf8'));
failures.push(...changelogFailures(readPending(root), changed ?? [], spec));
failures.push(...versionFailures(readVersions(root), baseVersions(root)));
if (failures.length) {
  console.error(`check-developers: ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('check-developers: ok');
