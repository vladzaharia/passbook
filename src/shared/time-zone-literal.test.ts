import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
/** Test files, fixtures and generated output: matched on the file name, never on a path word. */
const TEST_NAME =
  /\.test\.tsx?$|(^|-)fixtures?\.tsx?$|\.test-support\.tsx?$|^test-kit[\w-]*\.tsx?$/;

/**
 * Files where a UTC name is the zone's own name or a label, not a fallback for "no zone known":
 * the constants, the zone picker's labels, a label for a missing zone name, and the visitor files
 * being removed.
 */
const ZONE_NAME = new Set([
  'shared/time-zone.ts',
  'web/lib/timezones.ts',
  'web/admin/scanning/sessions/zone-name.ts',
  'passkit/build-local-time.ts',
  'worker/email/visitor.ts',
  'worker/modules/visitors/routes.ts',
]);

/**
 * `new Date(ms).toISOString().slice(0, 10)` is the UTC day. Allowed where the date is calendar
 * arithmetic, an import or export stamp, or a public page that names UTC days; anything a person
 * reads as "their" day goes through `localDate(ms, zone)`.
 */
const UTC_DAY = new Set([
  'shared/zoned.ts',
  'shared/mapping/transform.ts',
  'shared/privacy/summary.ts',
  'web/lib/format.ts',
  'web/developers/pages/status.tsx',
  'worker/modules/scan/feed.ts',
  'worker/modules/org-lifecycle/jobs.ts',
  'worker/platform/browser-signals.ts',
  'worker/modules/wallet-providers/projection-class-rule.ts',
  // The demo world is a synthetic wall clock (`ms` read with UTC fields): its days are calendar arithmetic.
  'worker/connectors/demo/people.ts',
  'worker/connectors/demo/world.ts',
  'worker/connectors/demo/datasets/transit-tickets.ts',
]);

/** `?? localZone()` reads "no zone known" as the browser's zone; only a page with no org may. */
const BROWSER_FALLBACK = new Set(['web/workbench/playground/live-paper.tsx']);
const BROWSER = /(?:\?\?|\|\|)\s*localZone\(\)/;

const NAME = /['"`](?:UTC|Etc\/UTC|GMT)['"`]/;
const DAY = /toISOString\(\)\s*\.slice\(0,\s*10\)/;

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'generated') yield* files(path);
    } else if (/\.tsx?$/.test(entry.name) && !TEST_NAME.test(basename(path))) yield path;
  }
}

const source = () =>
  [...files(SRC)].map((path) => ({
    path: relative(SRC, path),
    text: readFileSync(path, 'utf8'),
  }));

describe('time zone literals', () => {
  it('keep UTC, Etc/UTC and GMT out of source: use DEFAULT_TIME_ZONE, resolveOrgTimeZone or CALENDAR_ZONE', () => {
    const found = source()
      .filter((f) => !ZONE_NAME.has(f.path) && NAME.test(f.text))
      .map((f) => f.path);
    expect(found).toEqual([]);
  });

  it('keep the UTC day out of anything a person reads as their day', () => {
    const found = source()
      .filter((f) => !UTC_DAY.has(f.path) && DAY.test(f.text))
      .map((f) => f.path);
    expect(found).toEqual([]);
  });

  it('keep the browser zone from standing in for a missing org zone', () => {
    const found = source()
      .filter((f) => !BROWSER_FALLBACK.has(f.path) && BROWSER.test(f.text))
      .map((f) => f.path);
    expect(found).toEqual([]);
  });

  it('keep UTC out of the seed scripts: a zone-less org must show the default zone', () => {
    const tools = resolve(SRC, '..', 'tools');
    const seeds = [...files(join(tools, 'lib'))]
      .filter((p) => /demo-[\w-]+\.ts$/.test(p))
      .concat(join(tools, 'nfc-tags-fixtures.ts'));
    const found = seeds.filter((p) => NAME.test(readFileSync(p, 'utf8'))).map((p) => basename(p));
    expect(found).toEqual([]);
  });

  it('scans production files that only look like helpers', () => {
    const names = source().map((f) => f.path);
    expect(names).toContain('worker/platform/support.ts');
    expect(names.some((n) => n.includes('test-inbox'))).toBe(true);
  });
});
