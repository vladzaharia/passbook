// Fails when docs/api/openapi.v1.json breaks clients of the version on the base ref. Run in `npm run check:rules`.
// Base: $OPENAPI_BASE or origin/main. Without that ref (shallow clone) the check is skipped with a notice;
// src/worker/platform/openapi-snapshot.test.ts still pins the snapshot to the live document.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { breakingChanges, type Doc } from './lib/openapi-diff.ts';

const SNAPSHOT = 'docs/api/openapi.v1.json';
const root = resolve(import.meta.dirname, '..');
const base = process.env.OPENAPI_BASE ?? 'origin/main';

let prev: Doc;
try {
  prev = JSON.parse(
    execFileSync('git', ['show', `${base}:${SNAPSHOT}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Doc;
} catch {
  console.log(`check-openapi: no ${SNAPSHOT} on ${base}; skipped`);
  process.exit(0);
}
const next = JSON.parse(readFileSync(resolve(root, SNAPSHOT), 'utf8')) as Doc;
const found = breakingChanges(prev, next);
if (found.length) {
  console.error(`check-openapi: ${found.length} breaking change(s) against ${base}:`);
  for (const f of found) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-openapi: no breaking changes against ${base}`);
