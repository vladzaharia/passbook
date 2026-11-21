// Writes docs/api/changelog/unreleased.json: the diff of the OpenAPI snapshot against the base
// ref (OPENAPI_BASE or origin/main), keeping every note already written. Run via `npm run gen`;
// check-developers fails while an entry has no note.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergePending } from './lib/changelog.ts';
import { BASE, diffAgainstBase, json, readPending, UNRELEASED } from './lib/changelog-files.ts';

const root = resolve(import.meta.dirname, '..');
const changed = diffAgainstBase(root);
if (changed === null) console.log(`gen-changelog: no snapshot on ${BASE}; unreleased.json kept`);
else {
  const merged = mergePending(readPending(root), changed);
  writeFileSync(resolve(root, UNRELEASED), json(merged));
  const bare = merged.filter((p) => !p.note.trim()).length;
  console.log(`gen-changelog: ${merged.length} pending, ${bare} without a note`);
}
