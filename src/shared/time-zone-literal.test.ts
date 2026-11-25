import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
/** Test data and test helpers may name UTC. */
const TEST_FILE = /\.test\.tsx?$|test-|fixture|support|generated/;
/**
 * Files where a 'UTC' literal is the zone's own name, not a fallback for "no zone known":
 * the constant, the zone picker's labels, and the visitor files being removed.
 */
const ALLOWED = new Set([
  'shared/time-zone.ts',
  'web/lib/timezones.ts',
  'web/admin/scanning/sessions/zone-name.ts',
  'worker/email/visitor.ts',
  'worker/modules/visitors/routes.ts',
]);

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(entry.name) && !TEST_FILE.test(path)) yield path;
  }
}

describe('UTC literals', () => {
  it('stay out of source: use DEFAULT_TIME_ZONE, resolveOrgTimeZone or CALENDAR_ZONE', () => {
    const found = [...files(SRC)]
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => /['"`]UTC['"`]/.test(readFileSync(join(SRC, path), 'utf8')));
    expect(found).toEqual([]);
  });
});
