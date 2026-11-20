// Fails when docs/api/openapi.v1.json breaks clients of the version on the base ref, or breaks the SDK naming and coverage rules (tools/lib/openapi-ratchet.ts). Run in `npm run check:rules`.
// Base: $OPENAPI_BASE or origin/main. Without that ref (shallow clone) the check is skipped with a notice;
// src/worker/platform/openapi-snapshot.test.ts still pins the snapshot to the live document.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { breakingChanges, type Doc } from './lib/openapi-diff.ts';
import { coverage, FLAGS, ratchetFailures, type SdkNames } from './lib/openapi-ratchet.ts';

const SNAPSHOT = 'docs/api/openapi.v1.json';
const NAMES = 'docs/api/sdk-names.json';
const root = resolve(import.meta.dirname, '..');
const base = process.env.OPENAPI_BASE ?? 'origin/main';

const show = (ref: string, file: string): string | null => {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const parse = <T>(raw: string | null): T | null => (raw === null ? null : (JSON.parse(raw) as T));

const prev = parse<Doc>(show(base, SNAPSHOT));
const next = read<Doc>(SNAPSHOT);
const failures = ratchetFailures({
  base: prev,
  next,
  baseNames: parse<SdkNames>(show(base, NAMES)),
  nextNames: read<SdkNames>(NAMES),
});
if (prev) failures.push(...breakingChanges(prev, next));
else
  console.log(
    `check-openapi: no ${SNAPSHOT} on ${base}; breaking-change and coverage checks skipped`,
  );
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
