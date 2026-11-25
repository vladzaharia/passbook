// Fails when docs/api/openapi.v1.json breaks clients of the version on the base ref, or breaks the SDK naming and coverage rules (tools/lib/openapi-ratchet.ts). Run in `npm run check:rules`.
// Base: $OPENAPI_BASE or origin/main. Without that ref (shallow clone) the check is skipped with a notice;
// src/worker/platform/openapi-snapshot.test.ts still pins the snapshot to the live document.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasNewVersion, type Versions, versionedBreaks } from './lib/changelog.ts';
import { readPending } from './lib/changelog-files.ts';
import { exampleFailures } from './lib/example-lint.ts';
import { showAt } from './lib/git-show.ts';
import {
  type ApprovedRemoval,
  breakingChanges,
  type Doc,
  withoutApprovedRemovals,
} from './lib/openapi-diff.ts';
import { coverage, FLAGS, ratchetFailures, type SdkNames } from './lib/openapi-ratchet.ts';

const SNAPSHOT = 'docs/api/openapi.v1.json';
const NAMES = 'docs/api/sdk-names.json';
const root = resolve(import.meta.dirname, '..');
const base = process.env.OPENAPI_BASE ?? 'origin/main';

const show = (ref: string, file: string): string | null => showAt(root, ref, file);
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const parse = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

const approved = read<ApprovedRemoval[]>('tools/openapi-approved-removals.json');
const prev = parse<Doc>(show(base, SNAPSHOT));
const next = read<Doc>(SNAPSHOT);
const failures = ratchetFailures({
  base: prev,
  next,
  baseNames: parse<SdkNames>(show(base, NAMES)),
  nextNames: read<SdkNames>(NAMES),
  approvedIds: approved.map((a) => a.operationId),
});
if (prev) {
  // A breaking change ships only with a new dated PassBook-Version (docs/api/versions.json) that carries a migration note.
  // A breaking change the changelog marks `unversioned` (a safety fix) needs no version; any other does.
  const broken = versionedBreaks(
    withoutApprovedRemovals(breakingChanges(prev, next), approved),
    readPending(root),
  );
  const versions = read<Versions>('docs/api/versions.json');
  if (
    broken.length &&
    hasNewVersion(versions, parse<Versions>(show(base, 'docs/api/versions.json')))
  )
    console.log(
      `check-openapi: ${broken.length} breaking change(s) carried by a new PassBook-Version`,
    );
  else failures.push(...broken);
} else
  console.log(
    `check-openapi: no ${SNAPSHOT} on ${base}; breaking-change and coverage checks skipped`,
  );
failures.push(...exampleFailures(next));
const counts = coverage(next);
console.log(
  `check-openapi: key-callable coverage ${FLAGS.map((f) => `${f} ${counts[f][0]}/${counts[f][1]}`).join(', ')}`,
);
if (failures.length) {
  console.error(`check-openapi: ${failures.length} failure(s) against ${base}:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-openapi: ok against ${base}`);
