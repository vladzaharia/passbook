import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) yield path;
  }
}

/**
 * The pass_events_feed trigger inserts with OR IGNORE, and SQLite applies the outer statement's
 * conflict clause inside a trigger: a REPLACE into the ledger would REPLACE feed rows (cascading away
 * delivered state). Every ledger writer must use a plain INSERT.
 */
it('no writer uses INSERT OR REPLACE or REPLACE INTO pass_events', () => {
  const found: string[] = [];
  for (const file of sources(join(root, 'src/worker')))
    if (
      /(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\s+pass_events\b/i.test(readFileSync(file, 'utf8'))
    )
      found.push(file.slice(root.length + 1));
  expect(found).toEqual([]);
});
